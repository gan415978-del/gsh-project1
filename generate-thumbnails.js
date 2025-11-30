const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const uploadsDir = './public/uploads';
const thumbnailsDir = './public/uploads/thumbnails';

// Создаём директорию для миниатюр если её нет
if (!fs.existsSync(thumbnailsDir)) {
  fs.mkdirSync(thumbnailsDir, { recursive: true });
}

async function generateThumbnails() {
  try {
    const files = fs.readdirSync(uploadsDir);
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const file of files) {
      const filePath = path.join(uploadsDir, file);
      const stats = fs.statSync(filePath);

      // Пропускаем директории
      if (stats.isDirectory()) continue;

      // Пропускаем файлы, которые не являются изображениями
      if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(file)) {
        skipped++;
        continue;
      }

      const thumbnailPath = path.join(thumbnailsDir, `thumb_${file}`);

      // Проверяем, существует ли уже миниатюра
      if (fs.existsSync(thumbnailPath)) {
        console.log(`Миниатюра уже существует: ${file}`);
        skipped++;
        continue;
      }

      try {
        await sharp(filePath)
          .resize(800, 800, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ quality: 80 })
          .toFile(thumbnailPath);

        console.log(`✓ Создана миниатюра: ${file}`);
        processed++;
      } catch (error) {
        console.error(`✗ Ошибка обработки ${file}:`, error.message);
        errors++;
      }
    }

    console.log('\n=== Результаты ===');
    console.log(`Обработано: ${processed}`);
    console.log(`Пропущено: ${skipped}`);
    console.log(`Ошибок: ${errors}`);
  } catch (error) {
    console.error('Ошибка:', error);
  }
}

console.log('Начинаем генерацию миниатюр...\n');
generateThumbnails();
