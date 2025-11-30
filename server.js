const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const fs = require("fs");
const sharp = require("sharp");

const app = express();
app.use(cors());
app.use(express.json());

// --- ХРАНИЛИЩЕ (Картинки) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "public/uploads/";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(
      null,
      Date.now() +
        "-" +
        Math.round(Math.random() * 1e9) +
        path.extname(file.originalname)
    );
  },
});

// Увеличиваем лимит размера файла до 5MB
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    // Проверяем тип файла
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Только изображения разрешены"));
    }
    cb(null, true);
  },
});

// Функция для создания миниатюры изображения
async function createThumbnail(originalPath, thumbnailPath) {
  try {
    await sharp(originalPath)
      .resize(800, 800, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);
    return true;
  } catch (error) {
    console.error("Ошибка создания миниатюры:", error);
    return false;
  }
}

// Функция для валидации размеров изображения
async function validateImageDimensions(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const { width, height } = metadata;

    // Проверяем, что каждая сторона не превышает 10000px
    if (width > 10000 || height > 10000) {
      return { valid: false, width, height, reason: "dimension" };
    }

    // Проверяем общее количество пикселей (не более 25 мегапикселей)
    const totalPixels = width * height;
    const maxPixels = 25000000; // 25 мегапикселей (например, 5000x5000)

    if (totalPixels > maxPixels) {
      return { valid: false, width, height, reason: "megapixels", totalPixels };
    }

    return { valid: true, width, height };
  } catch (error) {
    console.error("Ошибка валидации изображения:", error);
    return { valid: false, error: error.message };
  }
}

// Настройки базы данных
const db = mysql.createPool({
  host: process.env.DB_HOST, // Ссылка на переменную в Amvera
  user: process.env.DB_USER, // Ссылка на переменную в Amvera
  password: process.env.DB_PASSWORD, // Ссылка на переменную в Amvera
  database: process.env.DB_NAME, // Ссылка на переменную в Amvera
  port: process.env.DB_PORT, // Ссылка на переменную в Amvera
});

db.connect((err) => {
  if (err) console.error("Ошибка БД:", err);
  else {
    console.log("MySQL подключен");
    // Создаем таблицу уведомлений, если её нет
    const createNotificationsTable = `
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        actor_id INT NOT NULL,
        post_id INT NOT NULL,
        type ENUM('reaction', 'comment') NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (post_id) REFERENCES articles(id) ON DELETE CASCADE,
        INDEX idx_user_read (user_id, is_read),
        INDEX idx_created (created_at DESC)
      )
    `;
    db.query(createNotificationsTable, (err) => {
      if (err) console.error("Ошибка создания таблицы notifications:", err);
      else console.log("Таблица notifications готова");
    });

    // Создаем таблицу альбомов
    const createAlbumsTable = `
      CREATE TABLE IF NOT EXISTS albums (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        cover_url VARCHAR(500),
        views INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_views (user_id, views DESC),
        INDEX idx_created (created_at DESC)
      )
    `;
    db.query(createAlbumsTable, (err) => {
      if (err) console.error("Ошибка создания таблицы albums:", err);
      else console.log("Таблица albums готова");
    });

    // Создаем таблицу скриншотов
    const createScreenshotsTable = `
      CREATE TABLE IF NOT EXISTS screenshots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        album_id INT NOT NULL,
        file_url VARCHAR(500) NOT NULL,
        thumbnail_url VARCHAR(500),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
        INDEX idx_album (album_id, uploaded_at DESC)
      )
    `;
    db.query(createScreenshotsTable, (err) => {
      if (err) console.error("Ошибка создания таблицы screenshots:", err);
      else {
        console.log("Таблица screenshots готова");

        // Добавляем колонки для размеров изображений, если их еще нет
        db.query("ALTER TABLE screenshots ADD COLUMN width INT", (err) => {
          if (err && !err.message.includes("Duplicate column"))
            console.error("Ошибка добавления width:", err);
        });
        db.query("ALTER TABLE screenshots ADD COLUMN height INT", (err) => {
          if (err && !err.message.includes("Duplicate column"))
            console.error("Ошибка добавления height:", err);
        });
        db.query(
          "ALTER TABLE screenshots ADD COLUMN title VARCHAR(255)",
          (err) => {
            if (err && !err.message.includes("Duplicate column"))
              console.error("Ошибка добавления title:", err);
          }
        );
      }
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

// --- АВТОРИЗАЦИЯ ---
app.post("/api/register", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ message: "Заполните поля" });

  try {
    const hash = await bcrypt.hash(password, 8);
    db.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)",
      [email, hash, name, "user"],
      (err) => {
        if (err) return res.status(500).json({ message: "Ошибка сервера" });
        res.json({ message: "Успешно" });
      }
    );
  } catch (e) {
    res.status(500).json({ message: "Error" });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  db.query(
    "SELECT * FROM users WHERE email = ?",
    [email],
    async (err, results) => {
      if (results.length === 0)
        return res.status(401).json({ message: "Неверные данные" });
      const user = results[0];
      if (!(await bcrypt.compare(password, user.password_hash)))
        return res.status(401).json({ message: "Неверные данные" });
      res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url,
        role: user.role,
      });
    }
  );
});

// --- ЗАГРУЗКА ---
// Создаем директорию для миниатюр
const thumbnailsDir = "public/uploads/thumbnails/";
if (!fs.existsSync(thumbnailsDir)) {
  fs.mkdirSync(thumbnailsDir, { recursive: true });
}

// Одиночная загрузка (для совместимости)
app.post("/api/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Нет файла" });

  const filePath = req.file.path;

  // Валидация размеров изображения
  const validation = await validateImageDimensions(filePath);
  if (!validation.valid) {
    fs.unlinkSync(filePath); // Удаляем файл
    if (validation.error) {
      return res.status(400).json({ message: "Ошибка обработки изображения" });
    }
    if (validation.reason === "megapixels") {
      const megapixels = (validation.totalPixels / 1000000).toFixed(1);
      return res.status(400).json({
        message: `Изображение слишком большое (${validation.width}x${validation.height}px = ${megapixels} Мп). Максимум 25 Мп`,
      });
    }
    return res.status(400).json({
      message: `Изображение слишком большое (${validation.width}x${validation.height}px). Максимум 10000x10000px`,
    });
  }

  // Создаем миниатюру
  const thumbnailFilename = `thumb_${req.file.filename}`;
  const thumbnailPath = path.join(thumbnailsDir, thumbnailFilename);
  await createThumbnail(filePath, thumbnailPath);

  res.json({
    url: `/uploads/${req.file.filename}`,
    thumbnail: `/uploads/thumbnails/${thumbnailFilename}`,
  });
});

// Множественная загрузка (до 15 файлов)
app.post(
  "/api/upload-multiple",
  upload.array("images", 15),
  async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "Нет файлов" });
    }

    const results = [];
    const errors = [];

    for (const file of req.files) {
      const filePath = file.path;

      // Валидация размеров изображения
      const validation = await validateImageDimensions(filePath);
      if (!validation.valid) {
        fs.unlinkSync(filePath); // Удаляем файл
        if (validation.error) {
          errors.push({
            filename: file.originalname,
            message: "Ошибка обработки изображения",
          });
        } else if (validation.reason === "megapixels") {
          const megapixels = (validation.totalPixels / 1000000).toFixed(1);
          errors.push({
            filename: file.originalname,
            message: `Изображение слишком большое (${validation.width}x${validation.height}px = ${megapixels} Мп). Максимум 25 Мп`,
          });
        } else {
          errors.push({
            filename: file.originalname,
            message: `Изображение слишком большое (${validation.width}x${validation.height}px). Максимум 10000x10000px`,
          });
        }
        continue;
      }

      // Создаем миниатюру
      const thumbnailFilename = `thumb_${file.filename}`;
      const thumbnailPath = path.join(thumbnailsDir, thumbnailFilename);
      await createThumbnail(filePath, thumbnailPath);

      results.push({
        url: `/uploads/${file.filename}`,
        thumbnail: `/uploads/thumbnails/${thumbnailFilename}`,
      });
    }

    if (results.length === 0 && errors.length > 0) {
      return res
        .status(400)
        .json({ message: "Все файлы были отклонены", errors });
    }

    res.json({
      images: results,
      errors: errors.length > 0 ? errors : undefined,
    });
  }
);

// --- ПОСТЫ ---
// 1. Получить список постов (Лента)
// --- ИСПРАВЛЕННЫЙ РОУТ ПОЛУЧЕНИЯ ПОСТОВ (БЕЗОПАСНЫЙ) ---
app.get("/api/posts", (req, res) => {
  const { sort, topicId, userId, authorId, search } = req.query;
  const currentUserId = userId || 0;

  // Проверяем, лайкнул ли текущий пользователь пост и добавил ли в закладки
  let sql = `
      SELECT articles.*,
      users.name as author_name,
      users.avatar_url as author_avatar,
      categories.name as category_name,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = articles.id AND user_id = ?) as is_liked,
      (SELECT COUNT(*) FROM post_bookmarks WHERE post_id = articles.id AND user_id = ?) as is_bookmarked,
      (SELECT COUNT(*) FROM post_bookmarks WHERE post_id = articles.id) as bookmarks_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = articles.id) as comments_count
      FROM articles
      JOIN users ON articles.author_id = users.id
      LEFT JOIN categories ON articles.category_id = categories.id`;

  let conds = [],
    params = [currentUserId, currentUserId];

  if (topicId) {
    conds.push("articles.category_id = ?");
    params.push(topicId);
  } else if (sort === "bookmarks" && userId) {
    conds.push(
      "articles.id IN (SELECT post_id FROM post_bookmarks WHERE user_id = ?)"
    );
    params.push(userId);
  } else if (sort === "feed" && userId) {
    conds.push(`(
        articles.author_id IN (SELECT target_author_id FROM subscriptions WHERE subscriber_id = ?)
        OR
        articles.category_id IN (SELECT target_category_id FROM subscriptions WHERE subscriber_id = ?)
    )`);
    params.push(userId, userId);
  } else if (authorId) {
    conds.push("articles.author_id = ?");
    params.push(authorId);
  }

  // Поиск по названию поста
  if (search) {
    conds.push("articles.title LIKE ?");
    params.push(`%${search}%`);
  }

  if (conds.length) sql += " WHERE " + conds.join(" AND ");

  if (sort === "popular") {
    // Популярность = просмотры + (лайки × 3)
    // Чем больше лайков, тем выше в рейтинге
    sql +=
      " ORDER BY (articles.views + IFNULL(articles.likes_count, 0) * 3) DESC";
  } else {
    sql += " ORDER BY articles.created_at DESC";
  }

  db.query(sql, params, async (err, results) => {
    if (err) {
      console.error("ОШИБКА DB:", err); // Покажет ошибку в консоли сервера, если она есть
      return res.status(500).send(err);
    }

    // Если постов нет, вернем пустой массив
    if (!results || results.length === 0) {
      return res.json([]);
    }

    // Загружаем изображения для каждого поста
    const postsWithImages = await Promise.all(
      results.map((post) => {
        return new Promise((resolve) => {
          db.query(
            "SELECT image_url FROM post_images WHERE post_id = ? ORDER BY display_order ASC",
            [post.id],
            (imgErr, images) => {
              if (imgErr) {
                console.error("Error loading images:", imgErr);
                post.images = [];
              } else {
                post.images = images.map((img) => img.image_url);
              }
              resolve(post);
            }
          );
        });
      })
    );

    res.json(postsWithImages);
  });
});

// Получить изображения для конкретного поста
app.get("/api/posts/:id/images", (req, res) => {
  db.query(
    "SELECT image_url FROM post_images WHERE post_id = ? ORDER BY display_order ASC",
    [req.params.id],
    (err, results) => {
      if (err) return res.status(500).send(err);
      res.json(results || []);
    }
  );
});

app.get("/api/posts/single/:id", (req, res) => {
  const userId = req.query.userId || null;

  const sql = `
    SELECT a.*,
      u.name AS author_name,
      u.avatar_url AS author_avatar,
      c.name AS category_name,
      ${
        userId
          ? `(SELECT COUNT(*) FROM post_likes WHERE post_id = a.id AND user_id = ${db.escape(
              userId
            )}) as is_liked`
          : "0 as is_liked"
      },
      ${
        userId
          ? `(SELECT COUNT(*) FROM post_bookmarks WHERE post_id = a.id AND user_id = ${db.escape(
              userId
            )}) as is_bookmarked`
          : "0 as is_bookmarked"
      },
      (SELECT COUNT(*) FROM post_bookmarks WHERE post_id = a.id) as bookmarks_count
    FROM articles a
    LEFT JOIN users u ON a.author_id = u.id
    LEFT JOIN categories c ON a.category_id = c.id
    WHERE a.id = ?`;

  db.query(sql, [req.params.id], (err, r) => {
    if (err) {
      console.error("SQL Error in /api/posts/single/:id:", err);
      return res.status(500).json({ error: err.message });
    }
    if (!r[0]) return res.json({});

    // Получаем изображения для этого поста
    db.query(
      "SELECT image_url FROM post_images WHERE post_id = ? ORDER BY display_order ASC",
      [req.params.id],
      (imgErr, images) => {
        if (imgErr) {
          console.error("SQL Error loading images:", imgErr);
          return res.status(500).json({ error: imgErr.message });
        }
        const post = r[0];
        post.images = images.map((img) => img.image_url);
        res.json(post);
      }
    );
  });
});

app.post("/api/posts/create", (req, res) => {
  const { title, content, author_id, category_id, images } = req.body;

  // Создаём пост
  db.query(
    "INSERT INTO articles (title, slug, content, author_id, category_id, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
    [title, "post-" + Date.now(), content, author_id, category_id],
    (err, result) => {
      if (err) return res.status(500).json(err);

      const postId = result.insertId;

      // Если есть изображения, добавляем их
      if (images && images.length > 0) {
        const values = images
          .slice(0, 15)
          .map((url, index) => [postId, url, index]);
        const sql =
          "INSERT INTO post_images (post_id, image_url, display_order) VALUES ?";

        db.query(sql, [values], (imgErr) => {
          if (imgErr) return res.status(500).json(imgErr);
          res.json({ message: "OK", postId });
        });
      } else {
        res.json({ message: "OK", postId });
      }
    }
  );
});

app.put("/api/posts/:id", (req, res) => {
  const { title, content, category_id, images } = req.body;
  const postId = req.params.id;

  // Обновляем пост
  db.query(
    "UPDATE articles SET title=?, content=?, category_id=? WHERE id=?",
    [title, content, category_id, postId],
    (err) => {
      if (err) return res.status(500).json(err);

      // Удаляем старые изображения
      db.query(
        "DELETE FROM post_images WHERE post_id=?",
        [postId],
        (delErr) => {
          if (delErr) return res.status(500).json(delErr);

          // Добавляем новые изображения (если есть)
          if (images && images.length > 0) {
            const values = images
              .slice(0, 15)
              .map((url, index) => [postId, url, index]);
            db.query(
              "INSERT INTO post_images (post_id, image_url, display_order) VALUES ?",
              [values],
              (imgErr) => {
                if (imgErr) return res.status(500).json(imgErr);
                res.json({ message: "OK" });
              }
            );
          } else {
            res.json({ message: "OK" });
          }
        }
      );
    }
  );
});

// Частичное обновление поста (только content)
app.patch("/api/posts/:id", (req, res) => {
  const { content, userId } = req.body;
  const postId = req.params.id;

  // Проверяем права доступа
  db.query(
    "SELECT author_id FROM articles WHERE id=?",
    [postId],
    (err, results) => {
      if (err) return res.status(500).json({ message: "Ошибка сервера" });
      if (results.length === 0)
        return res.status(404).json({ message: "Пост не найден" });

      const post = results[0];

      // Проверяем, является ли пользователь автором или админом
      db.query(
        "SELECT role FROM users WHERE id=?",
        [userId],
        (err, userResults) => {
          if (err) return res.status(500).json({ message: "Ошибка сервера" });
          if (userResults.length === 0)
            return res.status(403).json({ message: "Доступ запрещён" });

          const userRole = userResults[0].role;
          const isOwner = post.author_id === userId;
          const isAdmin = userRole === "admin";

          if (!isOwner && !isAdmin) {
            return res.status(403).json({ message: "Доступ запрещён" });
          }

          // Обновляем content поста
          db.query(
            "UPDATE articles SET content=? WHERE id=?",
            [content, postId],
            (err) => {
              if (err)
                return res.status(500).json({ message: "Ошибка обновления" });
              res.json({ message: "OK" });
            }
          );
        }
      );
    }
  );
});

app.delete("/api/posts/:id", (req, res) => {
  db.query("DELETE FROM articles WHERE id=?", [req.params.id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ message: "OK" });
  });
});

// Увеличить счетчик просмотров
app.post("/api/posts/:id/view", (req, res) => {
  db.query(
    "UPDATE articles SET views = views + 1 WHERE id = ?",
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ message: "OK" });
    }
  );
});

// --- ПОЛЬЗОВАТЕЛИ ---
app.put("/api/users/:id", (req, res) => {
  const userId = req.params.id;
  const { name, avatar_url, cover_url, status } = req.body;

  let sql = "UPDATE users SET ";
  let params = [];
  let updates = [];

  if (name) {
    updates.push("name = ?");
    params.push(name);
  }
  if (avatar_url !== undefined) {
    updates.push("avatar_url = ?");
    params.push(avatar_url);
  }
  if (cover_url !== undefined) {
    updates.push("cover_url = ?");
    params.push(cover_url);
  }
  if (status !== undefined) {
    updates.push("status = ?");
    params.push(status);
  }

  if (updates.length === 0) return res.json({ message: "Нет данных" });

  sql += updates.join(", ") + " WHERE id = ?";
  params.push(userId);

  db.query(sql, params, (err, result) => {
    if (err) return res.status(500).json({ error: err });

    // Возвращаем обновленного юзера
    db.query("SELECT * FROM users WHERE id = ?", [userId], (e, r) => {
      const user = r[0];
      delete user.password_hash; // Не шлем пароль
      res.json({ message: "Updated", user: user });
    });
  });
});

// === ПОЛУЧЕНИЕ ДАННЫХ ПОЛЬЗОВАТЕЛЯ (С ПОДСЧЕТОМ ПОДПИСОК) ===
app.get("/api/users/:id", (req, res) => {
  const userId = req.params.id;
  // Добавляем followers_count и following_count
  // following_count считает только подписки на ЛЮДЕЙ (target_author_id IS NOT NULL)
  // rating - сумма лайков на постах пользователя (исключая свои лайки)
  const sql = `
        SELECT
            users.id, users.name, users.avatar_url, users.cover_url, users.status, users.role, users.created_at,
            (SELECT COUNT(*) FROM articles WHERE author_id = users.id) as posts_count,
            (SELECT COUNT(*) FROM subscriptions WHERE target_author_id = users.id) as followers_count,
            (SELECT COUNT(*) FROM subscriptions WHERE subscriber_id = users.id AND target_author_id IS NOT NULL) as following_count,
            (SELECT COUNT(*) FROM comments c JOIN articles a ON c.post_id = a.id WHERE c.user_id = users.id AND a.author_id = users.id) as comments_count,
            (SELECT COUNT(*) FROM post_likes l JOIN articles a ON l.post_id = a.id WHERE a.author_id = users.id AND l.user_id != users.id) as rating
        FROM users
        WHERE users.id = ?
    `;
  db.query(sql, [userId], (err, result) => {
    if (err) return res.status(500).json({ error: err });
    res.json(result[0] || {});
  });
});

app.get("/api/top-users", (req, res) => {
  const sql = `
        SELECT
            users.id,
            users.name,
            users.avatar_url,
            (SELECT COUNT(*) FROM subscriptions WHERE target_author_id = users.id) as followers_count,
            (SELECT COUNT(*) FROM post_likes l JOIN articles a ON l.post_id = a.id WHERE a.author_id = users.id AND l.user_id != users.id) as rating
        FROM users
        ORDER BY rating DESC
        LIMIT 5
    `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).send(err);
    res.json(results || []);
  });
});

// --- ПОДПИСКИ (ОБНОВЛЕНО: ЛЮДИ + ТЕМЫ) ---
app.post("/api/subscribe", (req, res) => {
  const { subscriber_id, target_id, type } = req.body; // type: 'author' или 'topic'

  let queryCheck, queryDel, queryIns, params;

  if (type === "topic") {
    queryCheck =
      "SELECT * FROM subscriptions WHERE subscriber_id=? AND target_category_id=?";
    queryDel =
      "DELETE FROM subscriptions WHERE subscriber_id=? AND target_category_id=?";
    queryIns =
      "INSERT INTO subscriptions (subscriber_id, target_category_id) VALUES (?, ?)";
  } else {
    queryCheck =
      "SELECT * FROM subscriptions WHERE subscriber_id=? AND target_author_id=?";
    queryDel =
      "DELETE FROM subscriptions WHERE subscriber_id=? AND target_author_id=?";
    queryIns =
      "INSERT INTO subscriptions (subscriber_id, target_author_id) VALUES (?, ?)";
  }

  params = [subscriber_id, target_id];

  db.query(queryCheck, params, (err, results) => {
    if (err) return res.status(500).json(err);
    if (results.length > 0) {
      db.query(queryDel, params, () => res.json({ status: "unsubscribed" }));
    } else {
      db.query(queryIns, params, () => res.json({ status: "subscribed" }));
    }
  });
});

app.get("/api/check-subscription", (req, res) => {
  const { subscriber_id, target_id, type } = req.query;
  if (!subscriber_id || !target_id) return res.json({ isSubscribed: false });

  let sql;
  if (type === "topic") {
    sql =
      "SELECT * FROM subscriptions WHERE subscriber_id=? AND target_category_id=?";
  } else {
    sql =
      "SELECT * FROM subscriptions WHERE subscriber_id=? AND target_author_id=?";
  }

  db.query(sql, [subscriber_id, target_id], (err, r) => {
    res.json({ isSubscribed: r && r.length > 0 });
  });
});

// --- СООБЩЕНИЯ ---
app.post("/api/messages", (req, res) => {
  const { sender_id, receiver_id, content } = req.body;
  db.query(
    "INSERT INTO messages (sender_id, receiver_id, content, created_at) VALUES (?, ?, ?, NOW())",
    [sender_id, receiver_id, content],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ message: "OK" });
    }
  );
});
app.get("/api/messages/:userId", (req, res) => {
  const { myId, search } = req.query;

  let sql =
    "SELECT * FROM messages WHERE ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))";
  const params = [myId, req.params.userId, req.params.userId, myId];

  // Поиск по содержимому сообщения
  if (search) {
    sql += " AND content LIKE ?";
    params.push(`%${search}%`);
  }

  sql += " ORDER BY created_at ASC";

  db.query(sql, params, (e, r) => res.json(r || []));
});
// Получить список диалогов с последним сообщением
app.get("/api/conversations", (req, res) => {
  const { userId } = req.query;

  // Этот запрос делает следующее:
  // 1. Находит всех, с кем ты переписывался.
  // 2. Для каждого находит текст последнего сообщения (last_msg).
  // 3. Находит время последнего сообщения (last_date).
  // 4. Сортирует список: самые свежие переписки сверху.

  const sql = `
        SELECT 
            u.id AS partner_id,
            u.name,
            u.avatar_url,
            (
                SELECT content 
                FROM messages m 
                WHERE (m.sender_id = ? AND m.receiver_id = u.id) 
                   OR (m.sender_id = u.id AND m.receiver_id = ?)
                ORDER BY m.created_at DESC 
                LIMIT 1
            ) as last_msg,
            (
                SELECT created_at 
                FROM messages m2 
                WHERE (m2.sender_id = ? AND m2.receiver_id = u.id) 
                   OR (m2.sender_id = u.id AND m2.receiver_id = ?)
                ORDER BY m2.created_at DESC 
                LIMIT 1
            ) as last_date
        FROM users u
        WHERE u.id IN (
            SELECT receiver_id FROM messages WHERE sender_id = ?
            UNION
            SELECT sender_id FROM messages WHERE receiver_id = ?
        )
        ORDER BY last_date DESC
    `;

  // Мы передаем userId 6 раз, так как в запросе 6 знаков вопроса
  db.query(
    sql,
    [userId, userId, userId, userId, userId, userId],
    (err, results) => {
      if (err) return res.status(500).json({ error: err });
      res.json(results || []);
    }
  );
});

// --- УВЕДОМЛЕНИЯ ---
app.get("/api/notifications", (req, res) => {
  if (!req.query.userId) return res.json([]);
  db.query(
    "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 10",
    [req.query.userId],
    (e, r) => res.json(r || [])
  );
});

// --- ТЕМЫ (ОБНОВЛЕНО: С ПОДСЧЕТОМ ПОДПИСЧИКОВ) ---
app.get("/api/categories/:id", (req, res) => {
  const topicId = req.params.id;
  const sql = `
        SELECT c.*, 
        (SELECT COUNT(*) FROM subscriptions WHERE target_category_id = c.id) as subs_count 
        FROM categories c 
        WHERE c.id = ?
    `;
  db.query(sql, [topicId], (e, r) => {
    if (e) return res.status(500).send(e);
    res.json(r[0] || {});
  });
});

// --- НОВАЯ СИСТЕМА ЛАЙКОВ ---
// Поставить/убрать лайк
app.post("/api/posts/:id/like", (req, res) => {
  const postId = req.params.id;
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ message: "Не указан userId" });

  // Проверяем, есть ли уже лайк от этого пользователя
  db.query(
    "SELECT * FROM post_likes WHERE user_id=? AND post_id=?",
    [userId, postId],
    (err, results) => {
      if (err) return res.status(500).json(err);

      if (results.length > 0) {
        // Лайк уже есть -> Удаляем (Toggle Off)
        db.query(
          "DELETE FROM post_likes WHERE user_id=? AND post_id=?",
          [userId, postId],
          (deleteErr) => {
            if (deleteErr) return res.status(500).json(deleteErr);

            // Уменьшаем счетчик
            db.query(
              "UPDATE articles SET likes_count = GREATEST(likes_count - 1, 0) WHERE id=?",
              [postId],
              (updateErr) => {
                if (updateErr) return res.status(500).json(updateErr);

                // Получаем актуальный счетчик
                db.query(
                  "SELECT likes_count FROM articles WHERE id=?",
                  [postId],
                  (selectErr, results) => {
                    if (selectErr) return res.status(500).json(selectErr);
                    const likesCount = results[0]?.likes_count || 0;
                    res.json({ status: "removed", liked: false, likesCount });
                  }
                );
              }
            );
          }
        );
      } else {
        // Лайка нет -> Добавляем
        db.query(
          "INSERT INTO post_likes (user_id, post_id) VALUES (?, ?)",
          [userId, postId],
          (insertErr) => {
            if (insertErr) return res.status(500).json(insertErr);

            // Увеличиваем счетчик
            db.query(
              "UPDATE articles SET likes_count = likes_count + 1 WHERE id=?",
              [postId],
              (updateErr) => {
                if (updateErr) return res.status(500).json(updateErr);

                // Получаем автора поста для создания уведомления
                db.query(
                  "SELECT author_id FROM articles WHERE id=?",
                  [postId],
                  (authorErr, authorResults) => {
                    console.log(
                      "[LIKE] Результат запроса автора поста:",
                      authorErr,
                      authorResults
                    );
                    if (!authorErr && authorResults.length > 0) {
                      const postAuthorId = authorResults[0].author_id;
                      console.log(
                        `[LIKE] Автор поста: ${postAuthorId}, Лайкнул: ${userId}`
                      );
                      // Создаем уведомление для автора поста
                      createNotification(
                        postAuthorId,
                        userId,
                        postId,
                        "reaction"
                      );
                    } else {
                      console.log(
                        "[LIKE] Не удалось получить автора поста или ошибка"
                      );
                    }

                    // Получаем актуальный счетчик
                    db.query(
                      "SELECT likes_count FROM articles WHERE id=?",
                      [postId],
                      (selectErr, results) => {
                        if (selectErr) return res.status(500).json(selectErr);
                        const likesCount = results[0]?.likes_count || 0;
                        res.json({ status: "added", liked: true, likesCount });
                      }
                    );
                  }
                );
              }
            );
          }
        );
      }
    }
  );
});

// Переключение закладки (bookmark)
app.post("/api/posts/:id/bookmark", (req, res) => {
  const postId = req.params.id;
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ message: "Не указан userId" });

  // Проверяем, есть ли уже закладка от этого пользователя
  db.query(
    "SELECT * FROM post_bookmarks WHERE user_id=? AND post_id=?",
    [userId, postId],
    (err, results) => {
      if (err) return res.status(500).json(err);

      if (results.length > 0) {
        // Закладка уже есть -> Удаляем (Toggle Off)
        db.query(
          "DELETE FROM post_bookmarks WHERE user_id=? AND post_id=?",
          [userId, postId],
          (deleteErr) => {
            if (deleteErr) return res.status(500).json(deleteErr);

            // Получаем актуальный счетчик закладок
            db.query(
              "SELECT COUNT(*) as count FROM post_bookmarks WHERE post_id=?",
              [postId],
              (countErr, countResults) => {
                if (countErr) return res.status(500).json(countErr);
                const bookmarksCount = countResults[0]?.count || 0;
                res.json({
                  status: "removed",
                  bookmarked: false,
                  bookmarksCount,
                });
              }
            );
          }
        );
      } else {
        // Закладки нет -> Добавляем
        db.query(
          "INSERT INTO post_bookmarks (user_id, post_id) VALUES (?, ?)",
          [userId, postId],
          (insertErr) => {
            if (insertErr) return res.status(500).json(insertErr);

            // Получаем актуальный счетчик закладок
            db.query(
              "SELECT COUNT(*) as count FROM post_bookmarks WHERE post_id=?",
              [postId],
              (countErr, countResults) => {
                if (countErr) return res.status(500).json(countErr);
                const bookmarksCount = countResults[0]?.count || 0;
                res.json({ status: "added", bookmarked: true, bookmarksCount });
              }
            );
          }
        );
      }
    }
  );
});

// === КОММЕНТАРИИ ===
// Получить комментарии к посту
app.get("/api/posts/:id/comments", (req, res) => {
  const sql = `
        SELECT c.*, u.name as author_name, u.avatar_url
        FROM comments c
        JOIN users u ON c.user_id = u.id
        WHERE c.post_id = ?
        ORDER BY c.created_at ASC`;
  db.query(sql, [req.params.id], (err, result) => {
    if (err) return res.status(500).send(err);
    res.json(result);
  });
});

// Написать комментарий
app.post("/api/comments", (req, res) => {
  const { article_id, author_id, content } = req.body;
  db.query(
    "INSERT INTO comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, NOW())",
    [article_id, author_id, content],
    (err) => {
      if (err) return res.status(500).send(err);

      // Получаем автора поста для создания уведомления
      db.query(
        "SELECT author_id FROM articles WHERE id=?",
        [article_id],
        (authorErr, authorResults) => {
          console.log(
            "[COMMENT] Результат запроса автора поста:",
            authorErr,
            authorResults
          );
          if (!authorErr && authorResults.length > 0) {
            const postAuthorId = authorResults[0].author_id;
            console.log(
              `[COMMENT] Автор поста: ${postAuthorId}, Комментатор: ${author_id}`
            );
            // Создаем уведомление для автора поста
            createNotification(postAuthorId, author_id, article_id, "comment");
          } else {
            console.log(
              "[COMMENT] Не удалось получить автора поста или ошибка"
            );
          }
          res.json({ message: "Comment added" });
        }
      );
    }
  );
});

// Редактировать комментарий
app.put("/api/comments/:id", (req, res) => {
  const { content, userId } = req.body;
  const commentId = req.params.id;

  // Проверяем, что пользователь - автор комментария
  db.query(
    "SELECT user_id FROM comments WHERE id = ?",
    [commentId],
    (err, results) => {
      if (err) return res.status(500).json(err);
      if (results.length === 0)
        return res.status(404).json({ message: "Комментарий не найден" });
      if (results[0].user_id !== userId)
        return res.status(403).json({ message: "Нет прав" });

      // Обновляем
      db.query(
        "UPDATE comments SET content = ? WHERE id = ?",
        [content, commentId],
        (updateErr) => {
          if (updateErr) return res.status(500).json(updateErr);
          res.json({ message: "OK" });
        }
      );
    }
  );
});

// Удалить комментарий
app.delete("/api/comments/:id", (req, res) => {
  const commentId = req.params.id;
  const { userId } = req.body;

  // Проверяем права
  db.query(
    "SELECT user_id FROM comments WHERE id = ?",
    [commentId],
    (err, results) => {
      if (err) return res.status(500).json(err);
      if (results.length === 0)
        return res.status(404).json({ message: "Комментарий не найден" });
      if (results[0].user_id !== userId)
        return res.status(403).json({ message: "Нет прав" });

      // Удаляем
      db.query("DELETE FROM comments WHERE id = ?", [commentId], (delErr) => {
        if (delErr) return res.status(500).json(delErr);
        res.json({ message: "OK" });
      });
    }
  );
});

// Получить все комментарии пользователя (только его комментарии под его постами)
app.get("/api/users/:userId/comments", (req, res) => {
  const userId = req.params.userId;
  const sort = req.query.sort || "new"; // new или old

  const orderBy = sort === "old" ? "c.created_at ASC" : "c.created_at DESC";

  const sql = `
    SELECT
      c.*,
      u.name as author_name,
      u.avatar_url as author_avatar,
      a.id as post_id,
      a.title as post_title,
      a.author_id as post_author_id
    FROM comments c
    JOIN users u ON c.user_id = u.id
    JOIN articles a ON c.post_id = a.id
    WHERE c.user_id = ? AND a.author_id = ?
    ORDER BY ${orderBy}
  `;

  db.query(sql, [userId, userId], (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// === АДМИНКА: УПРАВЛЕНИЕ ТЕМАМИ ===

// 1. Создать тему
app.post("/api/categories", (req, res) => {
  const { name, description } = req.body;
  db.query(
    "INSERT INTO categories (name, description) VALUES (?, ?)",
    [name, description],
    (err, result) => {
      if (err) return res.status(500).json(err);
      res.json({ message: "Created", id: result.insertId });
    }
  );
});

// 2. Обновить тему (Аватар, Обложка, Описание)
app.put("/api/categories/:id", (req, res) => {
  const { name, description, avatar_url, cover_url } = req.body;
  let updates = [];
  let params = [];

  if (name) {
    updates.push("name = ?");
    params.push(name);
  }
  if (description) {
    updates.push("description = ?");
    params.push(description);
  }
  if (avatar_url !== undefined) {
    updates.push("avatar_url = ?");
    params.push(avatar_url);
  }
  if (cover_url !== undefined) {
    updates.push("cover_url = ?");
    params.push(cover_url);
  }

  if (updates.length === 0) return res.json({ message: "Нет данных" });

  const sql = `UPDATE categories SET ${updates.join(", ")} WHERE id = ?`;
  params.push(req.params.id);

  db.query(sql, params, (err) => {
    if (err) return res.status(500).json(err);
    res.json({ message: "Updated" });
  });
});

// 3. Удалить тему
app.delete("/api/categories/:id", (req, res) => {
  db.query("DELETE FROM categories WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ message: "Deleted" });
  });
});

// 4. Получить все темы (для сайдбара)
app.get("/api/categories", (req, res) => {
  db.query("SELECT * FROM categories", (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// Получить популярные темы (с количеством подписчиков)
app.get("/api/categories/popular/list", (req, res) => {
  const limit = req.query.limit || 10;
  const sql = `
    SELECT c.*,
           COUNT(s.id) as subscribers_count
    FROM categories c
    LEFT JOIN subscriptions s ON c.id = s.target_category_id
    GROUP BY c.id
    ORDER BY subscribers_count DESC
    LIMIT ?
  `;

  db.query(sql, [parseInt(limit)], (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// === УВЕДОМЛЕНИЯ ===

// Получить уведомления пользователя
app.get("/api/notifications/:userId", (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT
      n.id,
      n.type,
      n.is_read,
      n.created_at,
      u.id as actor_id,
      u.name as actor_name,
      u.avatar_url as actor_avatar,
      p.id as post_id,
      p.title as post_title
    FROM notifications n
    JOIN users u ON n.actor_id = u.id
    JOIN articles p ON n.post_id = p.id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 50
  `;

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("Ошибка загрузки уведомлений:", err);
      return res.status(500).json({ error: err.message });
    }
    res.json(Array.isArray(results) ? results : []);
  });
});

// Получить количество непрочитанных уведомлений
app.get("/api/notifications/:userId/unread-count", (req, res) => {
  const { userId } = req.params;
  const sql =
    "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE";

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("Ошибка получения счетчика:", err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ count: results[0]?.count || 0 });
  });
});

// Отметить уведомление как прочитанное
app.put("/api/notifications/:notificationId/read", (req, res) => {
  const { notificationId } = req.params;
  const sql = "UPDATE notifications SET is_read = TRUE WHERE id = ?";

  db.query(sql, [notificationId], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true });
  });
});

// Отметить все уведомления как прочитанные
app.put("/api/notifications/:userId/read-all", (req, res) => {
  const { userId } = req.params;
  const sql = "UPDATE notifications SET is_read = TRUE WHERE user_id = ?";

  db.query(sql, [userId], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true });
  });
});

// --- АЛЬБОМЫ И СКРИНШОТЫ ---

// Получить один альбом по ID
app.get("/api/album/:albumId", (req, res) => {
  const { albumId } = req.params;
  const sql = `
    SELECT a.id, a.title, a.cover_url, a.views, a.created_at, a.user_id,
           (SELECT COUNT(*) FROM screenshots WHERE album_id = a.id) as screenshot_count
    FROM albums a
    WHERE a.id = ?
  `;
  db.query(sql, [albumId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0)
      return res.status(404).json({ error: "Album not found" });
    res.json(results[0]);
  });
});

// Получить альбомы пользователя
app.get("/api/albums/:userId", (req, res) => {
  const { userId } = req.params;
  const { search, sort } = req.query;

  console.log(
    "GET /api/albums/:userId - userId:",
    userId,
    "search:",
    search,
    "sort:",
    sort
  );

  let sql = `
    SELECT a.id, a.title, a.cover_url, a.views, a.created_at,
           (SELECT COUNT(*) FROM screenshots WHERE album_id = a.id) as screenshot_count
    FROM albums a
    WHERE a.user_id = ?
  `;

  const params = [userId];

  // Поиск по названию альбома
  if (search) {
    sql += " AND a.title LIKE ?";
    params.push(`%${search}%`);
  }

  // Сортировка альбомов
  if (sort === "new") {
    sql += " ORDER BY a.created_at DESC";
  } else if (sort === "old") {
    sql += " ORDER BY a.created_at ASC";
  } else if (sort === "alpha") {
    sql += " ORDER BY a.title ASC";
  } else {
    // По умолчанию сортируем по новым
    sql += " ORDER BY a.created_at DESC";
  }

  console.log("SQL query:", sql);
  console.log("Params:", params);

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    console.log("Albums found:", results.length);
    res.json(results);
  });
});

// Получить топ-3 альбома пользователя (для профиля)
app.get("/api/albums/:userId/top", (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT a.id, a.title, a.cover_url, a.views,
           (SELECT COUNT(*) FROM screenshots WHERE album_id = a.id) as screenshot_count
    FROM albums a
    WHERE a.user_id = ?
    ORDER BY a.views DESC
    LIMIT 3
  `;
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// Создать альбом
app.post("/api/albums", (req, res) => {
  const { userId, title } = req.body;
  if (!userId || !title) {
    return res.status(400).json({ error: "userId и title обязательны" });
  }

  const sql = "INSERT INTO albums (user_id, title) VALUES (?, ?)";
  db.query(sql, [userId, title], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: result.insertId, message: "Альбом создан" });
  });
});

// Обновить альбом
app.put("/api/albums/:albumId", (req, res) => {
  const { albumId } = req.params;
  const { title, coverUrl } = req.body;

  let sql = "UPDATE albums SET ";
  const params = [];

  if (title) {
    sql += "title = ?";
    params.push(title);
  }

  if (coverUrl !== undefined) {
    if (params.length > 0) sql += ", ";
    sql += "cover_url = ?";
    params.push(coverUrl);
  }

  sql += " WHERE id = ?";
  params.push(albumId);

  db.query(sql, params, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Альбом обновлён" });
  });
});

// Установить скриншот как обложку альбома
app.post("/api/albums/:albumId/set-cover/:screenshotId", (req, res) => {
  const { albumId, screenshotId } = req.params;

  // Получаем URL миниатюры скриншота
  db.query(
    "SELECT thumbnail_url FROM screenshots WHERE id = ? AND album_id = ?",
    [screenshotId, albumId],
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.length === 0)
        return res.status(404).json({ error: "Скриншот не найден" });

      const thumbnailUrl = results[0].thumbnail_url;

      // Обновляем обложку альбома
      db.query(
        "UPDATE albums SET cover_url = ? WHERE id = ?",
        [thumbnailUrl, albumId],
        (updateErr) => {
          if (updateErr)
            return res.status(500).json({ error: updateErr.message });
          res.json({ message: "Обложка установлена", coverUrl: thumbnailUrl });
        }
      );
    }
  );
});

// Удалить альбом
app.delete("/api/albums/:albumId", (req, res) => {
  const { albumId } = req.params;
  const sql = "DELETE FROM albums WHERE id = ?";

  db.query(sql, [albumId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Альбом удалён" });
  });
});

// Увеличить просмотры альбома
app.post("/api/albums/:albumId/view", (req, res) => {
  const { albumId } = req.params;
  const sql = "UPDATE albums SET views = views + 1 WHERE id = ?";

  db.query(sql, [albumId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Просмотр учтён" });
  });
});

// Получить скриншоты альбома
app.get("/api/albums/:albumId/screenshots", (req, res) => {
  const { albumId } = req.params;
  const { sort, search } = req.query; // 'new' или 'old', search - поиск по названию

  const orderBy = sort === "old" ? "ASC" : "DESC";

  let sql = `
    SELECT id, file_url, thumbnail_url, title, uploaded_at, width, height
    FROM screenshots
    WHERE album_id = ?
  `;

  const params = [albumId];

  // Поиск по названию скриншота
  if (search) {
    sql += " AND title LIKE ?";
    params.push(`%${search}%`);
  }

  sql += ` ORDER BY uploaded_at ${orderBy}`;

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// Загрузить скриншоты в альбом
app.post(
  "/api/albums/:albumId/screenshots",
  upload.array("screenshots", 15),
  async (req, res) => {
    const { albumId } = req.params;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "Нет файлов для загрузки" });
    }

    try {
      // Создаем папку для миниатюр если её нет
      const thumbnailsDir = path.join(
        __dirname,
        "public",
        "uploads",
        "thumbnails"
      );
      if (!fs.existsSync(thumbnailsDir)) {
        fs.mkdirSync(thumbnailsDir, { recursive: true });
      }

      const insertPromises = files.map(async (file) => {
        const fileUrl = `/uploads/${file.filename}`;
        // Меняем расширение на .jpg для миниатюры
        const filenameWithoutExt = path.parse(file.filename).name;
        const thumbnailFilename = `thumb_${filenameWithoutExt}.jpg`;
        const thumbnailUrl = `/uploads/thumbnails/${thumbnailFilename}`;
        const thumbnailPath = path.join(thumbnailsDir, thumbnailFilename);

        // Получаем размеры изображения
        let width = null;
        let height = null;
        try {
          const metadata = await sharp(file.path).metadata();
          width = metadata.width;
          height = metadata.height;
        } catch (metadataErr) {
          console.error("Ошибка получения метаданных:", metadataErr);
        }

        // Создаем миниатюру с помощью sharp
        try {
          await sharp(file.path)
            .resize(800, 800, {
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 80 })
            .toFile(thumbnailPath);
        } catch (sharpErr) {
          console.error("Ошибка создания миниатюры:", sharpErr);
        }

        // Вставляем запись в БД с размерами
        return new Promise((resolve, reject) => {
          const sql =
            "INSERT INTO screenshots (album_id, file_url, thumbnail_url, width, height) VALUES (?, ?, ?, ?, ?)";
          db.query(
            sql,
            [albumId, fileUrl, thumbnailUrl, width, height],
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            }
          );
        });
      });

      await Promise.all(insertPromises);

      // Автоматически обновляем обложку на последний загруженный скриншот
      const filenameWithoutExt = path.parse(
        files[files.length - 1].filename
      ).name;
      const lastThumbnailUrl = `/uploads/thumbnails/thumb_${filenameWithoutExt}.jpg`;
      db.query(
        "UPDATE albums SET cover_url = ? WHERE id = ?",
        [lastThumbnailUrl, albumId],
        (updateErr) => {
          if (updateErr) console.error("Ошибка установки обложки:", updateErr);
        }
      );

      res.json({ message: `Загружено ${files.length} скриншотов` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Удалить скриншот
// Обновить название скриншота
app.put("/api/screenshots/:screenshotId", (req, res) => {
  const { screenshotId } = req.params;
  const { title } = req.body;

  const sql = "UPDATE screenshots SET title = ? WHERE id = ?";
  db.query(sql, [title, screenshotId], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Скриншот не найден" });
    }
    res.json({ message: "Название обновлено", title });
  });
});

app.delete("/api/screenshots/:screenshotId", (req, res) => {
  const { screenshotId } = req.params;

  // Сначала получим URL файла, чтобы удалить его с диска
  db.query(
    "SELECT file_url, thumbnail_url FROM screenshots WHERE id = ?",
    [screenshotId],
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.length === 0)
        return res.status(404).json({ error: "Скриншот не найден" });

      const { file_url, thumbnail_url } = results[0];

      // Удаляем запись из БД
      db.query(
        "DELETE FROM screenshots WHERE id = ?",
        [screenshotId],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });

          // Удаляем файлы с диска асинхронно
          const filePath = path.join(__dirname, "public", file_url);
          const thumbnailPath = path.join(__dirname, "public", thumbnail_url);

          // Асинхронное удаление с обработкой ошибок
          if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
              if (err) console.error("Ошибка при удалении файла:", err);
            });
          }
          if (fs.existsSync(thumbnailPath)) {
            fs.unlink(thumbnailPath, (err) => {
              if (err) console.error("Ошибка при удалении миниатюры:", err);
            });
          }

          res.json({ message: "Скриншот удалён" });
        }
      );
    }
  );
});

// --- ALBUM SUBSCRIPTIONS ---

// Подписаться на альбом
app.post("/api/albums/:albumId/subscribe", (req, res) => {
  const { albumId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(401).json({ error: "Требуется авторизация" });
  }

  // Проверяем, не подписан ли уже пользователь
  const checkSql =
    "SELECT id FROM album_subscriptions WHERE user_id = ? AND album_id = ?";
  db.query(checkSql, [userId, albumId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    if (results.length > 0) {
      return res.status(400).json({ error: "Уже подписаны на этот альбом" });
    }

    // Создаем подписку
    const insertSql =
      "INSERT INTO album_subscriptions (user_id, album_id) VALUES (?, ?)";
    db.query(insertSql, [userId, albumId], (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        message: "Подписка оформлена",
        subscriptionId: result.insertId,
      });
    });
  });
});

// Отписаться от альбома
app.delete("/api/albums/:albumId/subscribe", (req, res) => {
  const { albumId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(401).json({ error: "Требуется авторизация" });
  }

  const sql =
    "DELETE FROM album_subscriptions WHERE user_id = ? AND album_id = ?";
  db.query(sql, [userId, albumId], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Подписка не найдена" });
    }

    res.json({ message: "Подписка отменена" });
  });
});

// Проверить статус подписки
app.get("/api/albums/:albumId/subscription-status", (req, res) => {
  const { albumId } = req.params;
  const { userId } = req.query;

  if (!userId) {
    return res.json({ subscribed: false });
  }

  const sql =
    "SELECT id FROM album_subscriptions WHERE user_id = ? AND album_id = ?";
  db.query(sql, [userId, albumId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ subscribed: results.length > 0 });
  });
});

// Получить подписанные альбомы пользователя
app.get("/api/subscribed-albums/:userId", (req, res) => {
  const { userId } = req.params;
  const { search, sort } = req.query;

  console.log(
    "GET /api/subscribed-albums/:userId - userId:",
    userId,
    "search:",
    search,
    "sort:",
    sort
  );

  let sql = `
    SELECT a.id, a.title, a.cover_url, a.views, a.created_at, a.user_id,
           u.name as author_name, u.avatar_url as author_avatar,
           (SELECT COUNT(*) FROM screenshots WHERE album_id = a.id) as screenshot_count,
           (SELECT COUNT(*) FROM screenshots WHERE album_id = a.id AND uploaded_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) as new_screenshots_count
    FROM albums a
    INNER JOIN album_subscriptions asub ON a.id = asub.album_id
    INNER JOIN users u ON a.user_id = u.id
    WHERE asub.user_id = ?
  `;

  const params = [userId];

  if (search) {
    sql += " AND a.title LIKE ?";
    params.push(`%${search}%`);
  }

  // Сортировка альбомов
  if (sort === "new") {
    sql += " ORDER BY a.created_at DESC";
  } else if (sort === "old") {
    sql += " ORDER BY a.created_at ASC";
  } else if (sort === "alpha") {
    sql += " ORDER BY a.title ASC";
  } else {
    sql += " ORDER BY a.created_at DESC";
  }

  console.log("SQL query:", sql);
  console.log("Params:", params);

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    console.log("Subscribed albums found:", results.length);
    res.json(results);
  });
});

// Получить топ подписанных альбомов (для профиля)
app.get("/api/subscribed-albums/:userId/top", (req, res) => {
  const { userId } = req.params;

  const sql = `
    SELECT a.id, a.title, a.cover_url, a.user_id,
           u.name as author_name, u.avatar_url as author_avatar,
           (SELECT COUNT(*) FROM screenshots WHERE album_id = a.id) as screenshot_count,
           (SELECT COUNT(*) FROM screenshots WHERE album_id = a.id AND uploaded_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) as new_screenshots_count
    FROM albums a
    INNER JOIN album_subscriptions asub ON a.id = asub.album_id
    INNER JOIN users u ON a.user_id = u.id
    WHERE asub.user_id = ?
    ORDER BY a.created_at DESC
    LIMIT 3
  `;

  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// Создать уведомление (вспомогательная функция)
function createNotification(userId, actorId, postId, type, callback) {
  console.log(
    `[NOTIFICATION] Попытка создать уведомление: userId=${userId}, actorId=${actorId}, postId=${postId}, type=${type}`
  );

  // Не создаем уведомление, если пользователь сам совершил действие
  if (userId === actorId) {
    console.log(
      "[NOTIFICATION] Пропущено - пользователь сам совершил действие"
    );
    if (callback)
      callback(null, { message: "Self-action, no notification created" });
    return;
  }

  const sql =
    "INSERT INTO notifications (user_id, actor_id, post_id, type) VALUES (?, ?, ?, ?)";
  db.query(sql, [userId, actorId, postId, type], (err, result) => {
    if (err) {
      console.error("[NOTIFICATION] Ошибка создания уведомления:", err);
    } else {
      console.log(
        `[NOTIFICATION] Уведомление успешно создано: ID=${result.insertId}`
      );
    }
    if (callback) callback(err, result);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
