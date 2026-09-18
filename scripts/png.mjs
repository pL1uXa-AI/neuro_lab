/**
 * Разбор PNG без внешних зависимостей.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * Витрина должна убедиться, что сцена НЕ пуста, и единственный
 * достоверный источник — скриншот, то есть ровно то, что видит
 * пользователь.
 *
 * Почему не система извлечения Pixi: измерено, что `extract.pixels` на
 * `ParticleContainer` возвращает кадр, в котором частиц нет. Проверка
 * показала одинаковые ~1330 «светящихся» пикселей и для ОДНОГО нейрона, и
 * для 2500 — при том что на скриншоте в обоих случаях картинка разная.
 * Причина в том, что частицы рисуются отдельным батчем, и путь извлечения
 * их не подхватывает.
 *
 * Поэтому PNG разбирается вручную: zlib встроен в Node, а формат простой —
 * сигнатура, чанки, deflate-поток, построчные фильтры.
 */

import { inflateSync } from 'node:zlib';

/** Разобранное изображение: ширина, высота и RGBA-пиксели. */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('это не PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // длина + тип + данные + CRC

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('поддерживается только чересстрочный запрет');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`поддерживается только 8 бит на канал, а тут ${bitDepth}`);
  // 2 = RGB, 6 = RGBA.
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`поддерживается только RGB/RGBA, а тут тип ${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  // Обратные фильтры PNG: каждая строка предварена байтом типа фильтра.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? dst[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const value = src[x];
      switch (filter) {
        case 0: dst[x] = value; break;
        case 1: dst[x] = (value + a) & 0xff; break;
        case 2: dst[x] = (value + b) & 0xff; break;
        case 3: dst[x] = (value + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          dst[x] = (value + predictor) & 0xff;
          break;
        }
        default: throw new Error(`неизвестный фильтр PNG: ${filter}`);
      }
    }
  }

  return { width, height, channels, pixels };
}

/**
 * Доля светящихся пикселей.
 *
 * `minSum` — порог суммы каналов. Фон сцены #0b1018 даёт 51, покоящийся
 * нейрон — около 360, вспышка спайка — больше 700.
 */
export function brightFraction(image, minSum = 250) {
  const { pixels, channels } = image;
  let bright = 0;
  let total = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    total += 1;
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] > minSum) bright += 1;
  }
  return total > 0 ? (bright / total) * 100 : 0;
}
