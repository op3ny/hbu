/**
 * requireCaptcha.js — verificação opcional por CAPTCHA.
 *
 * Por padrão o HBU NÃO exige CAPTCHA: dá para rodar a ferramenta localmente
 * sem depender de nenhum serviço externo.
 *
 * Para exigir CAPTCHA, defina as variáveis de ambiente e ligue a verificação:
 *
 *   HBU_CAPTCHA_ENABLED=1
 *   HBU_CAPTCHA_VALIDATE_URL=https://seu-servidor/captcha/validate-token
 *   HBU_CAPTCHA_INVALIDATE_URL=https://seu-servidor/captcha/admin/invalidate  (opcional)
 *   HBU_CAPTCHA_ADMIN_TOKEN=<token-do-admin>                                  (opcional)
 *   HBU_CAPTCHA_COOKIE=nome_do_cookie                                         (opcional)
 *   HBU_CAPTCHA_USER_AGENT=hbu                                                (opcional)
 *
 * Rotas públicas (nunca pedem CAPTCHA): o leitor (`/`, `/leitor`),
 * `/index.html`, `/api/csrf-token` e os prefixos `/api/posts` e `/api/hdap`.
 */

"use strict";

const ENABLED = process.env.HBU_CAPTCHA_ENABLED === "1";
const VALIDATE_URL = process.env.HBU_CAPTCHA_VALIDATE_URL || "";
const INVALIDATE_URL = process.env.HBU_CAPTCHA_INVALIDATE_URL || "";
const ADMIN_TOKEN = process.env.HBU_CAPTCHA_ADMIN_TOKEN || "";
const COOKIE_NAME = process.env.HBU_CAPTCHA_COOKIE || "captcha_token";
const USER_AGENT = process.env.HBU_CAPTCHA_USER_AGENT || "hbu";

/* ============================================================================
 * ⚙️ CONFIGURAÇÃO
 * ========================================================================== */
const CONFIG = {
    CACHE_TTL: 10 * 60 * 1000, // 10 minutos
    CACHE_LIMIT: 10_000,

    // 🔥 Use-once (FORMATO OBRIGATÓRIO: METHOD:/endpoint)
    USE_ONCE_ENDPOINTS: [
        'POST:/api/register',
        'POST:/api/login'
    ],

    // 🌍 Públicos EXATOS
    PUBLIC_ROUTES_EXACT: [
        '/index.html',
        '/',
        '/api/csrf-token'
    ],

    // 🌍 Públicos por PREFIXO
    PUBLIC_ROUTES_PREFIX: [
        '/api/posts',
        '/api/hdap',
        '/leitor'
    ]
};

/* ============================================================================
 * 🧠 MEMÓRIA
 * ========================================================================== */

// token -> { ip, validatedAt }
const captchaValidCache = new Map();

// token -> Set<"METHOD:/endpoint">
const useOnceUsage = new Map();

/* ============================================================================
 * 🧹 LIMPEZA
 * ========================================================================== */
function cleanCache(now = Date.now()) {
    for (const [token, data] of captchaValidCache.entries()) {
        if (now - data.validatedAt > CONFIG.CACHE_TTL) {
            captchaValidCache.delete(token);
            useOnceUsage.delete(token);
        } else {
            break;
        }
    }

    while (captchaValidCache.size > CONFIG.CACHE_LIMIT) {
        const oldest = captchaValidCache.keys().next().value;
        captchaValidCache.delete(oldest);
        useOnceUsage.delete(oldest);
    }
}

setInterval(cleanCache, 5 * 60 * 1000).unref?.();

/* ============================================================================
 * 🚨 HTML ERROR RESPONSE
 * ========================================================================== */
function htmlError(res, message, status = 403) {
    res.status(status).send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Erro</title>
</head>
<body>
<script>
    alert(${JSON.stringify(message)});
    window.location = '/index.html';
</script>
</body>
</html>
    `);
}

/* ============================================================================
 * 🔗 INVALIDAÇÃO REMOTA (SERVIDOR CAPTCHA)
 * ========================================================================== */
function invalidateRemote(token) {
    if (!INVALIDATE_URL || !ADMIN_TOKEN || !token) return;

    const url =
        `${INVALIDATE_URL}?admin=${encodeURIComponent(
            ADMIN_TOKEN
        )}&token=${encodeURIComponent(token)}`;

    // fire-and-forget
    fetch(url).catch(() => {});
}

/* ============================================================================
 * 🚨 INVALIDAÇÃO TOTAL
 * ========================================================================== */
function invalidateToken(token) {
    captchaValidCache.delete(token);
    useOnceUsage.delete(token);
    invalidateRemote(token);
}

/* ============================================================================
 * 🛡️ MIDDLEWARE
 * ========================================================================== */
module.exports = async function requireCaptcha(req, res, next) {
    try {
        if (req.method === 'OPTIONS') return next();

        // CAPTCHA desligado (padrão) ou modo local: passa direto.
        if (
            !ENABLED ||
            !VALIDATE_URL ||
            process.env.BLOGGY_LOCAL === '1' ||
            process.env.BLOGGY_DISABLE_CAPTCHA === '1' ||
            process.env.HDAP_DISABLE_CAPTCHA === '1'
        ) {
            return next();
        }

        /* --------------------------------------------------
         * 🌍 PÚBLICOS
         * -------------------------------------------------- */
        if (
            CONFIG.PUBLIC_ROUTES_EXACT.includes(req.path) ||
            CONFIG.PUBLIC_ROUTES_PREFIX.some((p) => req.path.startsWith(p))
        ) {
            return next();
        }

        /* --------------------------------------------------
         * 🔒 PRIVADOS → TOKEN OBRIGATÓRIO
         * -------------------------------------------------- */
        const token = req.cookies?.[COOKIE_NAME];
        if (!token) {
            return htmlError(
                res,
                'Você precisa resolver o CAPTCHA para continuar.',
                401
            );
        }

        const forwardedFor = req.headers['x-forwarded-for'];
        const clientIp =
            typeof forwardedFor === 'string'
                ? forwardedFor.split(',')[0].trim()
                : req.ip;

        const now = Date.now();

        /* --------------------------------------------------
         * 🔥 USE-ONCE
         * -------------------------------------------------- */
        const endpointKey = `${req.method}:${req.path}`;

        if (CONFIG.USE_ONCE_ENDPOINTS.includes(endpointKey)) {
            let used = useOnceUsage.get(token);

            if (!used) {
                used = new Set();
                useOnceUsage.set(token, used);
            }

            if (used.has(endpointKey)) {
                invalidateToken(token);

                return htmlError(
                    res,
                    'Este endpoint só pode ser usado uma vez. Resolva o CAPTCHA novamente.'
                );
            }

            used.add(endpointKey);
        }

        /* --------------------------------------------------
         * 🧠 TOKEN JÁ VALIDADO
         * -------------------------------------------------- */
        const cached = captchaValidCache.get(token);

        if (cached) {
            if (
                cached.ip === clientIp &&
                now - cached.validatedAt <= CONFIG.CACHE_TTL
            ) {
                captchaValidCache.delete(token);
                captchaValidCache.set(token, cached);
                return next();
            }

            invalidateToken(token);
            return htmlError(res, 'Sessão CAPTCHA inválida.');
        }

        /* --------------------------------------------------
         * 🌐 VALIDAR NO SERVIDOR CAPTCHA
         * -------------------------------------------------- */
        const response = await fetch(
            `${VALIDATE_URL}?token=${encodeURIComponent(token)}`,
            {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': USER_AGENT,
                    'X-Forwarded-For': clientIp || ''
                }
            }
        );

        if (!response.ok) {
            return htmlError(res, 'Falha ao validar CAPTCHA.');
        }

        const data = await response.json();

        if (data.valid !== true) {
            return htmlError(
                res,
                data.message || 'CAPTCHA inválido ou expirado.'
            );
        }

        /* --------------------------------------------------
         * 🧠 REGISTRA COMO VÁLIDO
         * -------------------------------------------------- */
        captchaValidCache.set(token, {
            ip: clientIp,
            validatedAt: now
        });

        cleanCache(now);

        req.captcha = data;
        next();
    } catch (err) {
        console.error('[CAPTCHA]', err);
        htmlError(res, 'Erro interno ao validar CAPTCHA.');
    }
};
