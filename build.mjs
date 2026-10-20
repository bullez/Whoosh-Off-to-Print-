/* Сборка ui.html: вставляет src/core-svg.js, src/core-pdf.js и src/ui.js
   внутрь src/ui.html. Запуск:  node build.mjs
   Нужен только для разработки — готовый ui.html уже собран. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const parts = {
  '/*__CORE_SVG__*/': read('src/core-svg.js'),
  '/*__CORE_PDF__*/': read('src/core-pdf.js'),
  '/*__UI__*/': read('src/ui.js'),
};

let html = read('src/ui.html');
for (const [marker, code] of Object.entries(parts)) {
  if (!html.includes(marker)) throw new Error('Не найден маркер ' + marker);
  html = html.replace(marker, () => code);
  if (code.includes('</script>')) throw new Error('В коде есть </script> — сломает HTML');
}

fs.writeFileSync(path.join(root, 'ui.html'), html);

// проверка: не осталось ли маркеров
const left = Object.keys(parts).filter((m) => html.includes(m));
console.log('ui.html собран:', Math.round(html.length / 1024) + ' КБ',
  left.length ? 'ОСТАЛИСЬ МАРКЕРЫ: ' + left : '(маркеров не осталось)');
