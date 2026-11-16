# HBU — Hdap Blog Utility

Um **leitor bonito** e um **publicador de artigos** para a rede **HDAP**,
integrado ao **BloggySource**.

Qualquer pessoa consegue rodar, configurar e usar uma interface web para
**ler** os artigos publicados numa pasta da rede HDAP e **publicar/editar**
novos artigos na mesma estrutura — sem lidar com criptografia, tokens ou linha
de comando.

![stack](https://img.shields.io/badge/Node.js-18%2B-3c873a)
![license](https://img.shields.io/badge/license-MIT-8b5cf6)

---

## Como funciona

```
navegador ──► HBU (Express) ──► hdap-cli ──► nó HDAP
   /            /api/hdap/*      (thin client)
```

- **Leitor** (`/`) — página pública, visual roxo/preto, busca, filtro por
  categoria e leitura em Markdown. É a página inicial: ao abrir a ferramenta
  você já cai direto nos artigos do HDAP.
- **Painel** (`/blog.html`) — o **BloggySource** de sempre: posts, categorias,
  comentários e moderação. Todo post criado/editado aqui pode ser publicado
  automaticamente no HDAP (cópia local + espelho público).
- O servidor Node **não** reimplementa a criptografia do HDAP: ele conversa com
  o binário oficial **`hdap-cli`**, que cuida de identidade, autenticação e
  transporte.

Cada artigo é um arquivo `.md` na pasta configurada do espaço HDAP, no formato:

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

O nome do arquivo é `<id>-<slug-do-título>.md`
(ex.: `12-religião-a-maior-inimiga-da-razão.md`).

---

## Requisitos

- **Node.js 18+**
- O binário **`hdap-cli`** (v1.0.x), do projeto
  [HDAP](https://github.com/Hsyst-Eleuthery/hdap). Compile-o ou baixe um release
  e coloque em `bin/`.

---

## Instalação

```bash
npm install

# coloque o binário do CLI no projeto
mkdir -p bin && cp /caminho/para/hdap-cli bin/ && chmod +x bin/hdap-cli

npm start
```

Acesse:

- **Leitor:** <http://localhost:10293/>
- **Painel:** <http://localhost:10293/blog.html>

> Rodando localmente em `http://localhost`? Use `BLOGGY_LOCAL=1 npm start`
> para liberar cookies de sessão em HTTP e dispensar qualquer CAPTCHA.

Na primeira execução o app:

1. cria o banco local e um usuário **admin**. A senha é gerada
   aleatoriamente e **impressa no console** — ou defina `HBU_ADMIN_PASSWORD`
   antes de subir;
2. cria e registra automaticamente uma **identidade HDAP** local (apelido
   `hbu`), guardada em `data/identity/`;
3. passa a ler os artigos da pasta configurada e a publicar os posts do
   BloggySource no HDAP.

---

## Configurando o HDAP

Tudo é configurável pelo próprio leitor, no botão **⚙ Configurações** (visível
só para admins). As opções ficam salvas em `data/hdap-config.json`
(veja `hdap-config.example.json`).

### 1. Conexão

Informe **host**, **porta**, **TLS pin**, **dono do espaço** (`owner`) e a
**pasta dos artigos** do nó HDAP que você vai usar. Use **Testar conexão** para
confirmar (mostra o `server_id` do nó).

### 2. Identidade

A identidade (`hbu` por padrão) é gerada e registrada no primeiro uso, num cofre
local em `data/identity/`. Ela **nunca sai da sua máquina** — o que circula na
rede é só a chave pública/ID.

Para ver o **ID público**: *Configurações → Identidade → Preparar identidade*.

### 3. Permissão de escrita

Para **publicar**, a identidade precisa de permissão de escrita no espaço.
Copie o **ID público** (algo como `hbu_xxxxxxxxxxxxxxxx`) e compartilhe com quem
controla o espaço. Sem isso, a leitura funciona mas a publicação retorna
`403 forbidden: insufficient permission`.

### 4. Publicação

- **Automática:** com *Publicar automaticamente* ligado, todo `POST`/`PUT` de
  post no painel envia o artigo ao HDAP em segundo plano.
- **Manual:** no leitor, admins veem **＋ Novo artigo** e **✎ Editar**.
- **Em massa:** *Configurações → Avançado → Sincronizar todos os posts → HDAP*.

---

## Variáveis de ambiente

| Variável | Efeito |
| --- | --- |
| `PORT` | Porta do servidor (padrão `10293`) |
| `HDAP_CLI` | Caminho do binário `hdap-cli` (tem prioridade sobre tudo) |
| `SESSION_SECRET` | Chave fixa das sessões (mantém login entre reinícios) |
| `HBU_ADMIN_USER` / `HBU_ADMIN_EMAIL` | Usuário/e-mail do admin (padrão `admin` / `admin@hbu.local`) |
| `HBU_ADMIN_PASSWORD` | Senha do admin criado no primeiro boot |
| `BLOGGY_LOCAL=1` | Modo local: libera cookies em HTTP e dispensa CAPTCHA |
| `HBU_CAPTCHA_ENABLED=1` | Liga a exigência de CAPTCHA (veja `requireCaptcha.js`) |
| `HBU_CAPTCHA_VALIDATE_URL` | URL de validação do seu provedor de CAPTCHA |

---

## Rotas da API

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

## Estrutura dos arquivos

```
.
├── index.js                  # servidor Express (BloggySource + rotas HDAP)
├── hdap.js                   # integração com a rede HDAP (via hdap-cli)
├── requireCaptcha.js         # CAPTCHA opcional (desligado por padrão)
├── hdap-config.example.json  # exemplo de configuração
├── bin/                      # hdap-cli (não versionado)
├── data/                     # config + cofre da identidade (não versionado)
├── db/                       # banco SQLite (não versionado)
└── public/
    ├── leitor.html           # leitor/publicador HDAP (página inicial)
    ├── blog.html             # painel BloggySource
    └── ...
```

---

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| “hdap-cli não encontrado” | binário ausente | coloque em `bin/` ou defina `HDAP_CLI`/`cliPath` |
| `403 insufficient permission` ao publicar | a identidade não tem escrita no espaço | peça permissão usando o ID público |
| `certificate`/TLS ao conectar | `tlsPin` errado | confira o pin do nó em Configurações |
| Lista vazia mas o nó responde | `owner` ou `articlesPath` errados | confira os dois em Configurações |
| Login pede CAPTCHA | CAPTCHA ligado | use `BLOGGY_DISABLE_CAPTCHA=1` localmente |

Mais detalhes em [`docs/HDAP.md`](./docs/HDAP.md).

---

## Licença

MIT. Construído sobre o **BloggySource** e o protocolo **HDAP**
([Hsyst-Eleuthery/hdap](https://github.com/Hsyst-Eleuthery/hdap)).

---

Feito com <3 pela [Thaís (op3n/op3ny)](https://github.com/op3ny)
