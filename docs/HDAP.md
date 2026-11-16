# Integração HDAP

Documentação da camada que conecta o **BloggySource** à rede **HDAP**.

O BloggySource continua sendo o painel (posts, categorias, comentários,
moderação). O HDAP é o **espelho público** dos artigos: cada post criado ou
editado pode ser publicado automaticamente na rede, no mesmo formato de arquivo
usado pelo blog.

---

## Arquitetura

```
navegador ──► HBU (Express) ──► hdap-cli ──► nó HDAP
   /            /api/hdap/*      (thin client)
```

O servidor Node **não** reimplementa a criptografia 3FA do HDAP. Em vez disso
ele conversa com o binário oficial `hdap-cli`, que cuida de identidade,
autenticação e transporte. Isso mantém a ferramenta simples e compatível com
qualquer evolução do protocolo.

Todas as chamadas ao CLI são **serializadas** (`hdap.js`), porque o cofre/OTP é
sensível a concorrência.

---

## Onde colocar o `hdap-cli`

O servidor procura o binário, nesta ordem (no modo padrão):

1. A variável de ambiente `HDAP_CLI` (caminho completo do executável);
2. `bin/hdap-cli` ou `bin/hdap-cli.exe` dentro do projeto;
3. o `hdap-cli` do próprio PATH do sistema.

Se você tiver o binário em outro lugar, aponte o caminho em
**Configurações → hdap-cli → Caminho** (ou mude o modo para *“usar um hdap-cli
na minha máquina”*).

> O repositório não versiona o binário (`bin/` está no `.gitignore`).
> Compile/baixe o `hdap-cli` a partir do projeto
> [HDAP](https://github.com/Hsyst-Eleuthery/hdap) e copie-o para `bin/`.

---

## Primeira configuração (identidade)

A identidade (`hbu` por padrão) é **gerada e registrada automaticamente** no
primeiro uso, num cofre local em `data/identity/`. Ela nunca sai da sua
máquina — o que circula na rede é só a chave pública/ID.

Para ver o **ID público** e preparar/registrar manualmente:

1. Entre como admin no painel (`/blog.html`).
2. Abra **Configurações → Identidade**.
3. Clique em **Preparar identidade**.
4. Copie o **ID público** mostrado (algo como `hbu_xxxxxxxxxxxxxxxx`).

Esse ID é o que você compartilha com quem controla o espaço HDAP para receber
**permissão de escrita**. Sem ela, a leitura funciona mas a publicação retorna
`403 forbidden: insufficient permission`.

---

## Configurações disponíveis

Aberta pelo botão **⚙ Configurações** (visível só para admins):

| Aba | O que dá para ajustar |
| --- | --- |
| **Conexão** | host, porta, TLS pin, dono do espaço (`owner`), pasta dos artigos, origem do `hdap-cli`, ligar/desligar integração e publicação automática, link do BloggySource |
| **Identidade** | apelido, frase secreta, pasta do cofre e o ID público |
| **Aparência** | título e descrição do leitor, idioma |
| **Avançado** | tempo de cache da listagem e sincronização em massa |

Botões úteis:

- **Testar conexão** — consulta o `health` do nó e mostra `server_id`.
- **Preparar identidade** — cria/registra o cofre local.
- **Sincronizar todos os posts → HDAP** — publica todos os posts do
  BloggySource de uma vez.

Tudo é salvo em `data/hdap-config.json` (veja `hdap-config.example.json`).
O arquivo é local e não deve ser versionado.

---

## Publicando

### Pelo BloggySource (automático)

Com **Publicar automaticamente** ligado, todo `POST /api/posts` e
`PUT /api/posts/:id` dispara, em segundo plano, o upload do artigo para o
HDAP — no mesmo formato e nome de arquivo.

### Pelo leitor (manual)

Admins veem **＋ Novo artigo** e **✎ Editar** no leitor. O editor grava direto
na pasta de artigos do HDAP. O ID é sugerido automaticamente (maior ID entre o
banco local e a rede, +1).

---

## Formato do artigo

```
# <título>

**ID:** <id>

**Autor:** <autor>

**Publicado em:** <criado_em>

**Atualizado em:** <atualizado_em>

**Descrição:** <descrição>

**Categorias:** <categoria 1, categoria 2>

---

<conteúdo em markdown>
```

O nome do arquivo é `<id>-<slug-do-título>.md`. A ordem das categorias preserva
a ordem de inserção no banco.

---

## API

Todas em `/api/hdap`. As marcadas como **admin** exigem sessão de administrador
e token CSRF (`X-CSRF-Token`).

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/hdap/meta` | Metadados públicos para o leitor |
| `GET` | `/api/hdap/articles` | Lista de artigos (`?refresh=1` ignora o cache) |
| `GET` | `/api/hdap/articles/:name` | Um artigo completo |
| `GET` | `/api/hdap/config` | **admin** — configuração atual |
| `PUT` | `/api/hdap/config` | **admin** — salva configuração |
| `GET` | `/api/hdap/status` | **admin** — diagnóstico (nó, identidade, CLI) |
| `POST` | `/api/hdap/setup` | **admin** — cria/registra a identidade |
| `POST` | `/api/hdap/test` | **admin** — testa a conexão |
| `POST` | `/api/hdap/publish` | **admin** — publica (`{postId}` ou artigo completo) |
| `POST` | `/api/hdap/sync` | **admin** — publica todos os posts locais |
| `DELETE` | `/api/hdap/articles/:name` | **admin** — remove um artigo do HDAP |

---

## CAPTCHA (opcional)

O HBU vem com o CAPTCHA **desligado**. Para exigir verificação, defina as
variáveis e ligue:

```
HBU_CAPTCHA_ENABLED=1
HBU_CAPTCHA_VALIDATE_URL=https://seu-servidor/captcha/validate-token
HBU_CAPTCHA_INVALIDATE_URL=https://seu-servidor/captcha/admin/invalidate   # opcional
HBU_CAPTCHA_ADMIN_TOKEN=<token-do-admin>                                   # opcional
HBU_CAPTCHA_COOKIE=nome_do_cookie                                          # opcional
```

Ajuste também `public/index.html` para carregar o widget do seu provedor e
gravar o cookie esperado. Detalhes no cabeçalho de `requireCaptcha.js`.

---

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| “hdap-cli não encontrado” | binário ausente | coloque em `bin/` ou defina `HDAP_CLI`/`cliPath` |
| `403 insufficient permission` ao publicar | a identidade não tem escrita no espaço | peça permissão usando o ID público |
| `certificate`/TLS ao conectar | `tlsPin` errado | confira o pin do nó em Configurações |
| Lista vazia mas o nó responde | `owner` ou `articlesPath` errados | confira os dois em Configurações |
| Publicação não acontece | publicação automática desligada | ligue em Configurações ou use **Sincronizar** |
| Login pede CAPTCHA | CAPTCHA ligado | use `BLOGGY_DISABLE_CAPTCHA=1` localmente |

---

Feito com <3 pela [Thaís (op3n/op3ny)](https://github.com/op3ny)
