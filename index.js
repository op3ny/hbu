const express = require("express");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const csrf = require("csurf");
const cookieParser = require("cookie-parser");
const { v4: uuidv4 } = require("uuid");
// VERIGATE CAPTCHA
const requireCaptcha = require('./requireCaptcha');
// HDAP: leitura e publicação de artigos na rede HDAP
const hdap = require("./hdap");

// Configurações iniciais
const config = {
  port: Number(process.env.PORT) || 10293,
  // Defina SESSION_SECRET para manter as sessões entre reinícios.
  sessionSecret: process.env.SESSION_SECRET || "hbu-" + uuidv4(),
  saltRounds: 12,
  adminUsername: process.env.HBU_ADMIN_USER || "admin",
  adminEmail: process.env.HBU_ADMIN_EMAIL || "admin@hbu.local",
  // Configurações de rate limiting
  rateLimit: {
    windowMs: 5 * 60 * 1000, // 5 minutos
    max: 100, // limite cada IP para 100 requisições por janela
  },
  // Configurações de CSRF
  csrf: {
    cookie: true,
  },
};

// Modo local: permite rodar em http://localhost sem CAPTCHA e sem cookies
// "secure" (que só funcionam atrás de HTTPS). Em produção, mantenha desligado.
const LOCAL_MODE =
  process.env.BLOGGY_LOCAL === "1" ||
  process.env.BLOGGY_DISABLE_CAPTCHA === "1" ||
  process.env.HDAP_DISABLE_CAPTCHA === "1" ||
  process.env.BLOGGY_INSECURE_COOKIES === "1";

// Inicialização do app Express
const app = express();

// Configuração de middlewares de segurança
// Add CSP headers
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["*"],
      scriptSrc: ["*", "'unsafe-inline'"],
      styleSrc: ["*", "'unsafe-inline'"],
      imgSrc: ["*", "data:"],
      fontSrc: ["*"],
      connectSrc: ["*"],
      objectSrc: ["*"],
      mediaSrc: ["*"],
      frameSrc: ["*"],
      // Em modo local (http://localhost) não force upgrade para HTTPS.
      ...(LOCAL_MODE ? { upgradeInsecureRequests: null } : {}),
    },
  }),
);

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
// VeriGate CAPTCHA
app.use(cookieParser());

app.use(requireCaptcha);

// Configuração de rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
});
app.use(limiter);

// Caminhos do banco de dados (relativos ao projeto, não ao diretório atual).
const dbDir = path.join(__dirname, "db");
const dbPath = path.join(dbDir, "bloggysource.db");
// Garante que o diretório existe antes de abrir o banco e a store de sessões.
fs.mkdirSync(dbDir, { recursive: true });

// Configuração de sessão
app.use(
  session({
    store: new SQLiteStore({
      db: "sessions.db",
      dir: dbDir,
    }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: !LOCAL_MODE,
      httpOnly: false,
      maxAge: 24 * 60 * 60 * 1000, // 1 dia
    },
  }),
);

// Configuração de CSRF
const csrfProtection = csrf(config.csrf);
app.use(csrfProtection);

// Servir arquivos estáticos (sem servir index.html automaticamente em "/",
// para que a rota "/" caia direto no leitor HDAP).
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Inicialização do banco de dados SQLite
const db = new sqlite3.Database(
  dbPath,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) {
      console.error("Erro ao conectar ao banco de dados:", err.message);
    } else {
      console.log("Conectado ao banco de dados SQLite");
      initializeDatabase();
    }
  },
);

// Inicialização do banco de dados
function initializeDatabase() {
  db.serialize(() => {
    // Tabela de usuários
    db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

    // Tabela de posts
    db.run(`CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            description TEXT,
            image_url TEXT,
            views INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`);

    // Tabela de categorias
    //db.run(`CREATE TABLE IF NOT EXISTS categories (
    //        id INTEGER PRIMARY KEY AUTOINCREMENT,
    //        name TEXT UNIQUE NOT NULL,
    //        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    //    )`);

    // Tabela de categorias (modificada)
    db.run(`CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            created_by INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users (id)
    )`);

    // Tabela de relacionamento post-categoria
    db.run(`CREATE TABLE IF NOT EXISTS post_categories (
            post_id INTEGER NOT NULL,
            category_id INTEGER NOT NULL,
            PRIMARY KEY (post_id, category_id),
            FOREIGN KEY (post_id) REFERENCES posts (id),
            FOREIGN KEY (category_id) REFERENCES categories (id)
        )`);

    // Tabela de comentários
    db.run(`CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            is_approved BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (post_id) REFERENCES posts (id),
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`);

    // Tabela de moderação
    db.run(`CREATE TABLE IF NOT EXISTS moderations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            moderator_id INTEGER NOT NULL,
            post_id INTEGER,
            comment_id INTEGER,
            action TEXT NOT NULL,
            reason TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (moderator_id) REFERENCES users (id),
            FOREIGN KEY (post_id) REFERENCES posts (id),
            FOREIGN KEY (comment_id) REFERENCES comments (id)
        )`);

    // Criar usuário admin se não existir
    db.get(
      "SELECT id FROM users WHERE username = ?",
      [config.adminUsername],
      (err, row) => {
        if (err) {
          console.error("Erro ao verificar usuário admin:", err);
          return;
        }

        if (!row) {
          // A senha do admin pode vir de HBU_ADMIN_PASSWORD; se não vier,
          // é gerada aleatoriamente e mostrada uma única vez no console.
          const adminPassword = process.env.HBU_ADMIN_PASSWORD || uuidv4();
          bcrypt.hash(adminPassword, config.saltRounds, (err, hash) => {
            if (err) {
              console.error("Erro ao criar hash da senha do admin:", err);
              return;
            }

            db.run(
              "INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, TRUE)",
              [config.adminUsername, config.adminEmail, hash],
              function (err) {
                if (err) {
                  console.error("Erro ao criar usuário admin:", err);
                } else {
                  console.log(
                    `Usuário admin criado com sucesso. Credenciais:\nUsername: ${config.adminUsername}\nPassword: ${adminPassword}`,
                  );
                }
              },
            );
          });
        }
      },
    );
  });
}

// Middleware para verificar autenticação
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
}

// Middleware para verificar se é admin
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  next();
}

// Página inicial: cai direto no leitor HDAP (página pública).
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "leitor.html"));
});

// Leitor HDAP (mesma página, endereço alternativo)
app.get(["/leitor", "/leitor/"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "leitor.html"));
});

// Rota para obter token CSRF
app.get("/api/csrf-token", (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// Rotas de autenticação
app.post("/api/register", async (req, res) => {
  const { username, email, password, confirmPassword } = req.body;

  // Validações básicas
  if (!username || !email || !password || !confirmPassword) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios" });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: "As senhas não coincidem" });
  }

  if (password.length < 8) {
    return res
      .status(400)
      .json({ error: "A senha deve ter pelo menos 8 caracteres" });
  }

  try {
    // Verificar se usuário ou email já existem
    const existingUser = await new Promise((resolve, reject) => {
      db.get(
        "SELECT id FROM users WHERE username = ? OR email = ?",
        [username, email],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        },
      );
    });

    if (existingUser) {
      return res
        .status(400)
        .json({ error: "Nome de usuário ou email já em uso" });
    }

    // Hash da senha
    const hashedPassword = await bcrypt.hash(password, config.saltRounds);

    // Criar usuário
    const result = await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
        [username, email, hashedPassword],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        },
      );
    });

    // Iniciar sessão
    req.session.userId = result.lastID;
    req.session.username = username;
    req.session.isAdmin = false;

    res.status(201).json({
      message: "Registro bem-sucedido",
      user: { id: result.lastID, username, email },
    });
  } catch (err) {
    console.error("Erro no registro:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Nome de usuário e senha são obrigatórios" });
  }

  try {
    // Buscar usuário
    const user = await new Promise((resolve, reject) => {
      db.get(
        "SELECT id, username, email, password_hash, is_admin FROM users WHERE username = ?",
        [username],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        },
      );
    });

    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    // Verificar senha
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    // Iniciar sessão
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;

    res.json({
      message: "Login bem-sucedido",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.is_admin,
      },
    });
  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Erro ao fazer logout:", err);
      return res.status(500).json({ error: "Erro ao fazer logout" });
    }
    res.clearCookie("connect.sid");
    res.json({ message: "Logout bem-sucedido" });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  res.json({
    user: {
      id: req.session.userId,
      username: req.session.username,
      isAdmin: req.session.isAdmin,
    },
  });
});

// Rotas de posts
app.get("/api/posts", async (req, res) => {
  try {
    const posts = await new Promise((resolve, reject) => {
      db.all(
        `SELECT p.id, p.title, p.description, p.image_url, p.views, p.created_at,
                 u.username as author,
                 GROUP_CONCAT(c.name) as categories
                 FROM posts p
                 JOIN users u ON p.user_id = u.id
                 LEFT JOIN post_categories pc ON p.id = pc.post_id
                 LEFT JOIN categories c ON pc.category_id = c.id
                 GROUP BY p.id
                 ORDER BY p.created_at DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });

    // Transformar string de categorias em array
    const formattedPosts = posts.map((post) => ({
      ...post,
      categories: post.categories ? post.categories.split(",") : [],
    }));

    res.json(formattedPosts);
  } catch (err) {
    console.error("Erro ao buscar posts:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.get("/api/posts/:id", async (req, res) => {
  const postId = req.params.id;

  try {
    // Buscar post
    const post = await new Promise((resolve, reject) => {
      db.get(
        `SELECT p.*, u.username as author
                 FROM posts p
                 JOIN users u ON p.user_id = u.id
                 WHERE p.id = ?`,
        [postId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        },
      );
    });

    if (!post) {
      return res.status(404).json({ error: "Post não encontrado" });
    }

    // Buscar categorias do post
    const categories = await new Promise((resolve, reject) => {
      db.all(
        `SELECT c.id, c.name
                 FROM post_categories pc
                 JOIN categories c ON pc.category_id = c.id
                 WHERE pc.post_id = ?`,
        [postId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });

    // Buscar comentários aprovados
    const comments = await new Promise((resolve, reject) => {
      db.all(
        `SELECT c.id, c.content, c.created_at, u.username as author
                 FROM comments c
                 JOIN users u ON c.user_id = u.id
                 WHERE c.post_id = ? AND c.is_approved = TRUE
                 ORDER BY c.created_at DESC`,
        [postId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });

    // Incrementar visualizações
    db.run("UPDATE posts SET views = views + 1 WHERE id = ?", [postId]);

    res.json({
      ...post,
      categories,
      comments,
    });
  } catch (err) {
    console.error("Erro ao buscar post:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.post("/api/posts", requireAdmin, async (req, res) => {
  const { title, content, description, image_url, categories } = req.body;
  const userId = req.session.userId;

  if (!title || !content) {
    return res
      .status(400)
      .json({ error: "Título e conteúdo são obrigatórios" });
  }

  try {
    // Inserir post
    const result = await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO posts (user_id, title, content, description, image_url) VALUES (?, ?, ?, ?, ?)",
        [userId, title, content, description || null, image_url || null],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        },
      );
    });

    const postId = result.lastID;

    // Processar categorias
    if (categories && categories.length > 0) {
      // Verificar e criar categorias que não existem
      for (const categoryName of categories) {
        // Verificar se a categoria existe
        let category = await new Promise((resolve, reject) => {
          db.get(
            "SELECT id FROM categories WHERE name = ?",
            [categoryName],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            },
          );
        });

        // Se não existir, criar
        if (!category) {
          const insertResult = await new Promise((resolve, reject) => {
            db.run(
              "INSERT INTO categories (name, created_by) VALUES (?, ?)",
              [categoryName, userId],
              function (err) {
                if (err) reject(err);
                else resolve(this);
              },
            );
          });

          category = { id: insertResult.lastID };
        }

        // Associar categoria ao post
        await new Promise((resolve, reject) => {
          db.run(
            "INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)",
            [postId, category.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            },
          );
        });
      }
    }

    res.status(201).json({
      message: "Post criado com sucesso",
      postId,
    });

    // Espelha o post recém-criado no HDAP (se a publicação automática estiver ligada).
    maybeAutoPublishHdap(postId);
  } catch (err) {
    console.error("Erro ao criar post:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.put("/api/posts/:id", requireAdmin, async (req, res) => {
  const postId = req.params.id;
  const { title, content, description, image_url, categories } = req.body;
  const userId = req.session.userId;

  if (!title || !content) {
    return res
      .status(400)
      .json({ error: "Título e conteúdo são obrigatórios" });
  }

  try {
    // Verificar se o post existe e pertence ao usuário (ou usuário é admin)
    const post = await new Promise((resolve, reject) => {
      db.get("SELECT user_id FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!post) {
      return res.status(404).json({ error: "Post não encontrado" });
    }

    if (post.user_id !== userId && !req.session.isAdmin) {
      return res
        .status(403)
        .json({ error: "Você não tem permissão para editar este post" });
    }

    // Atualizar post
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE posts
                 SET title = ?, content = ?, description = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
        [title, content, description || null, image_url || null, postId],
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    // Atualizar categorias
    // Primeiro, remover todas as categorias atuais
    await new Promise((resolve, reject) => {
      db.run(
        "DELETE FROM post_categories WHERE post_id = ?",
        [postId],
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    // Depois, adicionar as novas categorias (se houver)
    if (categories && categories.length > 0) {
      for (const categoryName of categories) {
        // Verificar se a categoria existe
        let category = await new Promise((resolve, reject) => {
          db.get(
            "SELECT id FROM categories WHERE name = ?",
            [categoryName],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            },
          );
        });

        // Se não existir, criar
        if (!category) {
          const insertResult = await new Promise((resolve, reject) => {
            db.run(
              "INSERT INTO categories (name, created_by) VALUES (?, ?)",
              [categoryName, userId],
              function (err) {
                if (err) reject(err);
                else resolve(this);
              },
            );
          });

          category = { id: insertResult.lastID };
        }

        // Associar categoria ao post
        await new Promise((resolve, reject) => {
          db.run(
            "INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)",
            [postId, category.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            },
          );
        });
      }
    }

    res.json({ message: "Post atualizado com sucesso" });

    // Atualiza também a versão publicada no HDAP.
    maybeAutoPublishHdap(postId);
  } catch (err) {
    console.error("Erro ao atualizar post:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.delete("/api/posts/:id", requireAuth, async (req, res) => {
  const postId = req.params.id;
  const userId = req.session.userId;
  const isAdmin = req.session.isAdmin;

  try {
    // Verificar se o post existe
    const post = await new Promise((resolve, reject) => {
      db.get("SELECT user_id FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!post) {
      return res.status(404).json({ error: "Post não encontrado" });
    }

    // Verificar permissões (autor ou admin)
    if (post.user_id !== userId && !isAdmin) {
      return res
        .status(403)
        .json({ error: "Você não tem permissão para excluir este post" });
    }

    // Registrar ação de moderação se for admin
    if (isAdmin && post.user_id !== userId) {
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO moderations (moderator_id, post_id, action, reason) VALUES (?, ?, ?, ?)",
          [userId, postId, "delete", "Moderação administrativa"],
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });
    }

    // Excluir post (o SQLite configurado com ON DELETE CASCADE cuidará das dependências)
    await new Promise((resolve, reject) => {
      db.run("DELETE FROM posts WHERE id = ?", [postId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ message: "Post excluído com sucesso" });
  } catch (err) {
    console.error("Erro ao excluir post:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rotas de comentários
app.post("/api/posts/:id/comments", requireAuth, async (req, res) => {
  const postId = req.params.id;
  const { content } = req.body;
  const userId = req.session.userId;

  if (!content) {
    return res
      .status(400)
      .json({ error: "Conteúdo do comentário é obrigatório" });
  }

  try {
    // Verificar se o post existe
    const postExists = await new Promise((resolve, reject) => {
      db.get("SELECT id FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      });
    });

    if (!postExists) {
      return res.status(404).json({ error: "Post não encontrado" });
    }

    // Inserir comentário
    const isApproved = req.session.isAdmin; // Comentários de admins são aprovados automaticamente

    const result = await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO comments (post_id, user_id, content, is_approved) VALUES (?, ?, ?, ?)",
        [postId, userId, content, isApproved],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        },
      );
    });

    res.status(201).json({
      message: isApproved
        ? "Comentário adicionado"
        : "Comentário enviado para moderação",
      commentId: result.lastID,
      isApproved,
    });
  } catch (err) {
    console.error("Erro ao adicionar comentário:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rotas de moderação (apenas para admins)
app.get("/api/moderation/comments", requireAdmin, async (req, res) => {
  try {
    const comments = await new Promise((resolve, reject) => {
      db.all(
        `SELECT c.id, c.content, c.created_at, c.is_approved,
                 u.username as author, p.title as post_title, p.id as post_id
                 FROM comments c
                 JOIN users u ON c.user_id = u.id
                 JOIN posts p ON c.post_id = p.id
                 WHERE c.is_approved = FALSE
                 ORDER BY c.created_at DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });

    res.json(comments);
  } catch (err) {
    console.error("Erro ao buscar comentários para moderação:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.post(
  "/api/moderation/comments/:id/approve",
  requireAdmin,
  async (req, res) => {
    const commentId = req.params.id;
    const moderatorId = req.session.userId;

    try {
      // Verificar se o comentário existe
      const comment = await new Promise((resolve, reject) => {
        db.get(
          "SELECT id, is_approved FROM comments WHERE id = ?",
          [commentId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          },
        );
      });

      if (!comment) {
        return res.status(404).json({ error: "Comentário não encontrado" });
      }

      if (comment.is_approved) {
        return res.status(400).json({ error: "Comentário já está aprovado" });
      }

      // Aprovar comentário
      await new Promise((resolve, reject) => {
        db.run(
          "UPDATE comments SET is_approved = TRUE WHERE id = ?",
          [commentId],
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      // Registrar ação de moderação
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO moderations (moderator_id, comment_id, action) VALUES (?, ?, ?)",
          [moderatorId, commentId, "approve"],
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      res.json({ message: "Comentário aprovado com sucesso" });
    } catch (err) {
      console.error("Erro ao aprovar comentário:", err);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  },
);

app.post(
  "/api/moderation/comments/:id/reject",
  requireAdmin,
  async (req, res) => {
    const commentId = req.params.id;
    const { reason } = req.body;
    const moderatorId = req.session.userId;

    try {
      // Verificar se o comentário existe
      const comment = await new Promise((resolve, reject) => {
        db.get(
          "SELECT id FROM comments WHERE id = ?",
          [commentId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          },
        );
      });

      if (!comment) {
        return res.status(404).json({ error: "Comentário não encontrado" });
      }

      // Registrar ação de moderação
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO moderations (moderator_id, comment_id, action, reason) VALUES (?, ?, ?, ?)",
          [
            moderatorId,
            commentId,
            "reject",
            reason || "Comentário rejeitado por moderação",
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      // Excluir comentário
      await new Promise((resolve, reject) => {
        db.run("DELETE FROM comments WHERE id = ?", [commentId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      res.json({ message: "Comentário rejeitado e removido com sucesso" });
    } catch (err) {
      console.error("Erro ao rejeitar comentário:", err);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  },
);

// Rotas de dashboard (apenas para admins)
app.get("/api/dashboard/stats", requireAdmin, async (req, res) => {
  try {
    const stats = await new Promise((resolve, reject) => {
      db.get(
        `SELECT
                 (SELECT COUNT(*) FROM posts) as total_posts,
                 (SELECT SUM(views) FROM posts) as total_views,
                 (SELECT COUNT(*) FROM comments WHERE is_approved = TRUE) as total_comments,
                 (SELECT COUNT(*) FROM users) as total_users`,
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        },
      );
    });

    res.json(stats);
  } catch (err) {
    console.error("Erro ao buscar estatísticas:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para obter usuários (apenas admin)
app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    const users = await new Promise((resolve, reject) => {
      db.all(
        "SELECT id, username, email, is_admin, created_at FROM users ORDER BY created_at DESC",
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });
    res.json(users);
  } catch (err) {
    console.error("Erro ao buscar usuários:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para atualizar status de admin
app.put("/api/users/:id/admin", requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { is_admin } = req.body;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE users SET is_admin = ? WHERE id = ?",
        [is_admin, userId],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        },
      );
    });
    res.json({ message: "Status de admin atualizado com sucesso" });
  } catch (err) {
    console.error("Erro ao atualizar status de admin:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para deletar usuário
app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  const userId = req.params.id;

  try {
    // Verificar se é o último admin
    const user = await new Promise((resolve, reject) => {
      db.get(
        "SELECT is_admin FROM users WHERE id = ?",
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        },
      );
    });

    if (user.is_admin) {
      const adminCount = await new Promise((resolve, reject) => {
        db.get(
          "SELECT COUNT(*) as count FROM users WHERE is_admin = TRUE",
          (err, row) => {
            if (err) reject(err);
            else resolve(row.count);
          },
        );
      });

      if (adminCount <= 1) {
        return res
          .status(400)
          .json({ error: "Não é possível remover o último admin" });
      }
    }

    await new Promise((resolve, reject) => {
      db.run("DELETE FROM users WHERE id = ?", [userId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    res.json({ message: "Usuário excluído com sucesso" });
  } catch (err) {
    console.error("Erro ao excluir usuário:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para obter categorias
app.get("/api/categories", async (req, res) => {
  try {
    const categories = await new Promise((resolve, reject) => {
      db.all(
        `SELECT c.id, c.name, COUNT(pc.post_id) as post_count
                 FROM categories c
                 LEFT JOIN post_categories pc ON c.id = pc.category_id
                 GROUP BY c.id
                 ORDER BY c.name`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      );
    });
    res.json(categories);
  } catch (err) {
    console.error("Erro ao buscar categorias:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para criar categoria
app.post("/api/categories", requireAdmin, async (req, res) => {
  const { name } = req.body;
  const userId = req.session.userId;

  if (!name) {
    return res.status(400).json({ error: "Nome da categoria é obrigatório" });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO categories (name, created_by) VALUES (?, ?)",
        [name, userId],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        },
      );
    });
    res.status(201).json({ id: result.lastID, name });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT") {
      return res.status(400).json({ error: "Categoria já existe" });
    }
    console.error("Erro ao criar categoria:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para deletar categoria
app.delete("/api/categories/:id", requireAdmin, async (req, res) => {
  const categoryId = req.params.id;
  const userId = req.session.userId;
  const isAdmin = req.session.isAdmin;

  try {
    // Primeiro verificar se a categoria existe e quem criou
    const category = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, created_by 
         FROM categories 
         WHERE id = ?`,
        [categoryId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!category) {
      return res.status(404).json({ error: "Categoria não encontrada" });
    }

    // Verificar se o usuário é o criador ou admin
    if (category.created_by !== userId && !isAdmin) {
      return res.status(403).json({ 
        error: "Apenas o criador da categoria ou administradores podem excluí-la" 
      });
    }

    // Se passar nas verificações, deletar a categoria
    await new Promise((resolve, reject) => {
      db.run("DELETE FROM categories WHERE id = ?", [categoryId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ message: "Categoria excluída com sucesso" });
  } catch (err) {
    console.error("Erro ao excluir categoria:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

/* ==================================================================
 * HDAP — leitura e publicação de artigos
 * ==================================================================
 * O BloggySource continua sendo o painel; o HDAP é o espelho público
 * dos artigos. Estas rotas falam com a rede através do `hdap-cli`.
 */

function hdapErrorText(err) {
  try {
    return hdap.humanError(err);
  } catch (_) {
    return "Erro ao falar com o HDAP";
  }
}

// Dica extra quando falta permissão de escrita no espaço.
function hdapPermissionHint(err) {
  if (hdap.httpStatusFromError(err) !== 403) return "";
  return (
    " Sem permissão de escrita neste espaço. Compartilhe o ID público da " +
    "identidade (Configurações → Identidade) com quem controla o espaço HDAP " +
    "para liberar a publicação."
  );
}

function sendHdapError(res, err, status = 500) {
  const msg = hdapErrorText(err) + hdapPermissionHint(err);
  console.error("[HDAP]", msg);
  res.status(status).json({ error: msg });
}

// Carrega um post do BloggySource no formato que o HDAP espera.
function loadPostForHdap(postId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT p.id, p.title, p.content, p.description, p.created_at, p.updated_at,
              u.username AS author
         FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.id = ?`,
      [postId],
      (err, post) => {
        if (err) return reject(err);
        if (!post) return resolve(null);
        db.all(
          // Sem ORDER BY: preserva a ordem original de inserção das categorias.
          `SELECT c.name FROM post_categories pc
             JOIN categories c ON pc.category_id = c.id
            WHERE pc.post_id = ?`,
          [postId],
          (err2, rows) => {
            if (err2) return reject(err2);
            resolve({ ...post, categories: rows.map((r) => r.name) });
          },
        );
      },
    );
  });
}

function allPostsForHdap() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT p.id, p.title, p.content, p.description, p.created_at, p.updated_at,
              u.username AS author
         FROM posts p JOIN users u ON p.user_id = u.id
        ORDER BY p.id ASC`,
      [],
      (err, posts) => {
        if (err) return reject(err);
        db.all(
          `SELECT pc.post_id, c.name FROM post_categories pc
             JOIN categories c ON pc.category_id = c.id`,
          [],
          (err2, cats) => {
            if (err2) return reject(err2);
            const byPost = {};
            for (const c of cats) (byPost[c.post_id] = byPost[c.post_id] || []).push(c.name);
            resolve(posts.map((p) => ({ ...p, categories: byPost[p.id] || [] })));
          },
        );
      },
    );
  });
}

// Data no mesmo formato usado pelo BloggySource/SQLite: "YYYY-MM-DD HH:MM:SS".
function sqlNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function toHdapPost(raw) {
  return {
    id: raw.id,
    title: raw.title,
    content: raw.content || "",
    description: raw.description || "",
    author: raw.author || "",
    publishedAt: raw.publishedAt || raw.created_at || "",
    updatedAt: raw.updatedAt || raw.updated_at || "",
    categories: raw.categories || [],
  };
}

// Próximo ID livre, considerando o banco local e o que já existe no HDAP.
async function nextArticleId() {
  const local = await new Promise((resolve, reject) => {
    db.get("SELECT COALESCE(MAX(id), 0) AS m FROM posts", [], (err, row) => {
      if (err) reject(err);
      else resolve(row.m);
    });
  });
  let remote = 0;
  try {
    const items = await hdap.getArticles();
    remote = items.reduce((m, a) => Math.max(m, a.id || 0), 0);
  } catch (_) {
    /* se não der para listar, seguimos só com o banco local */
  }
  return Math.max(local, remote) + 1;
}

function maybeAutoPublishHdap(postId) {
  const cfg = hdap.getConfig();
  if (!cfg.enabled || !cfg.autoPublish || !hdap.cliAvailable()) return;
  setImmediate(() => {
    loadPostForHdap(postId)
      .then((raw) => {
        if (!raw) return null;
        return hdap.publishPost(toHdapPost(raw));
      })
      .then((r) => {
        if (r) console.log(`[HDAP] post ${postId} publicado em ${r.path}`);
      })
      .catch((err) =>
        console.warn(
          `[HDAP] falha ao publicar o post ${postId}: ${hdapErrorText(err)}`,
        ),
      );
  });
}

// --- Metadados públicos para o leitor ---
app.get("/api/hdap/meta", (req, res) => {
  const c = hdap.getConfig();
  res.json({
    enabled: !!c.enabled,
    siteTitle: c.siteTitle,
    siteDescription: c.siteDescription,
    language: c.language,
    owner: c.owner,
    articlesPath: c.articlesPath,
    node: { host: c.host, port: c.port },
    bloggysourceUrl: c.bloggysourceUrl || "",
    autoPublish: !!c.autoPublish,
  });
});

// --- Lista de artigos (público) ---
app.get("/api/hdap/articles", async (req, res) => {
  try {
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const articles = await hdap.getArticles({ refresh });
    res.json({ articles, fetchedAt: Date.now() });
  } catch (err) {
    sendHdapError(res, err);
  }
});

// --- Um artigo completo (público) ---
app.get("/api/hdap/articles/:name", async (req, res) => {
  try {
    const article = await hdap.getArticleByFile(req.params.name);
    res.json({ article });
  } catch (err) {
    sendHdapError(res, err);
  }
});

// --- Configuração (admin) ---
const HDAP_CONFIG_KEYS = [
  "enabled",
  "mode",
  "cliPath",
  "host",
  "port",
  "tlsPin",
  "owner",
  "articlesPath",
  "nickname",
  "identityHome",
  "passphrase",
  "autoPublish",
  "cacheTtlMs",
  "bloggysourceUrl",
  "siteTitle",
  "siteDescription",
  "language",
];

app.get("/api/hdap/config", requireAdmin, (req, res) => {
  res.json({ config: hdap.publicConfig(), defaults: hdap.DEFAULT_CONFIG });
});

app.put("/api/hdap/config", requireAdmin, (req, res) => {
  try {
    const patch = {};
    for (const k of HDAP_CONFIG_KEYS) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        patch[k] = req.body[k];
      }
    }
    if (patch.port != null) patch.port = parseInt(patch.port, 10) || 8443;
    if (patch.cacheTtlMs != null)
      patch.cacheTtlMs = parseInt(patch.cacheTtlMs, 10) || 0;
    hdap.saveConfig(patch);
    res.json({ message: "Configuração salva", config: hdap.publicConfig() });
  } catch (err) {
    sendHdapError(res, err);
  }
});

// --- Diagnóstico / preparação da identidade (admin) ---
app.get("/api/hdap/status", requireAdmin, async (req, res) => {
  try {
    res.json({ status: await hdap.status() });
  } catch (err) {
    sendHdapError(res, err);
  }
});

app.post("/api/hdap/setup", requireAdmin, async (req, res) => {
  try {
    const result = await hdap.setup({ force: !!(req.body && req.body.force) });
    res.json({ message: "Identidade HDAP pronta", ...result });
  } catch (err) {
    sendHdapError(res, err);
  }
});

app.post("/api/hdap/test", requireAdmin, async (req, res) => {
  try {
    res.json({ status: await hdap.status() });
  } catch (err) {
    sendHdapError(res, err);
  }
});

// --- Publicar (admin) ---
app.post("/api/hdap/publish", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    let post;

    if (body.postId) {
      const raw = await loadPostForHdap(body.postId);
      if (!raw) return res.status(404).json({ error: "Post não encontrado" });
      post = toHdapPost(raw);
    } else {
      if (!body.title || !body.content) {
        return res
          .status(400)
          .json({ error: "Título e conteúdo são obrigatórios" });
      }
      const categories = Array.isArray(body.categories)
        ? body.categories
        : String(body.categories || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
      let articleId = body.id != null ? parseInt(body.id, 10) : null;
      if (!articleId || Number.isNaN(articleId)) articleId = await nextArticleId();
      const now = sqlNow();
      post = {
        id: articleId,
        title: body.title,
        content: body.content,
        description: body.description || "",
        author:
          body.author || req.session.username || hdap.getConfig().nickname,
        publishedAt: body.publishedAt || now,
        updatedAt: body.updatedAt || now,
        categories,
      };
    }

    const result = await hdap.publishPost(post);
    res.json({ message: "Artigo publicado no HDAP", id: post.id, ...result });
  } catch (err) {
    sendHdapError(res, err);
  }
});

// --- Sincronizar todos os posts locais para o HDAP (admin) ---
app.post("/api/hdap/sync", requireAdmin, async (req, res) => {
  try {
    const posts = await allPostsForHdap();
    const results = [];
    for (const p of posts) {
      try {
        const r = await hdap.publishPost(toHdapPost(p));
        results.push({ id: p.id, file: r.file, ok: true });
      } catch (err) {
        results.push({ id: p.id, ok: false, error: hdapErrorText(err) });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    res.json({ message: `${ok}/${results.length} artigos publicados`, results });
  } catch (err) {
    sendHdapError(res, err);
  }
});

// --- Remover um artigo do HDAP (admin) ---
app.delete("/api/hdap/articles/:name", requireAdmin, async (req, res) => {
  try {
    const result = await hdap.deleteArticle(req.params.name);
    res.json({ message: "Artigo removido do HDAP", ...result });
  } catch (err) {
    sendHdapError(res, err);
  }
});

// Middleware para tratamento de erros
app.use((err, req, res, next) => {
  console.error(err.stack);

  if (err.code === "EBADCSRFTOKEN") {
    return res.status(403).json({ error: "Token CSRF inválido" });
  }

  res.status(500).json({ error: "Erro interno do servidor" });
});

// Preparar a integração HDAP (config + identidade em segundo plano)
try {
  hdap.init();
} catch (err) {
  console.warn("[HDAP] não foi possível inicializar:", err.message);
}

// Iniciar servidor
app.listen(config.port, () => {
  console.log(`Servidor BloggySource rodando na porta ${config.port}`);
  console.log(`Leitor HDAP: http://localhost:${config.port}/leitor`);
});

// Fechar conexão com o banco de dados ao encerrar o servidor
process.on("SIGINT", () => {
  db.close();
  process.exit();
});
