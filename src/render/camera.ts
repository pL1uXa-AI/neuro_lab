/**
 * Камера: преобразование «мир → экран».
 *
 * Перенесена из phys-lab с упрощениями: вращения нет, потому что
 * пространственные сцены плоские (решётка или случайное облако), и
 * поворот только затруднял бы чтение координат.
 */

export class Camera {
  /** Смещение центра обзора в мировых координатах. */
  x = 0;
  y = 0;
  /** Масштаб: пикселей на единицу мира. */
  zoom = 20;
  /** Размер области отрисовки в пикселях. */
  width = 800;
  height = 600;

  /** Мировые координаты → экранные. */
  toScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: (worldX - this.x) * this.zoom + this.width / 2,
      y: (worldY - this.y) * this.zoom + this.height / 2,
    };
  }

  /** Экранные координаты → мировые. */
  toWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.width / 2) / this.zoom + this.x,
      y: (screenY - this.height / 2) / this.zoom + this.y,
    };
  }

  /** Подогнать масштаб под содержимое с полями. */
  fit(width: number, height: number, margin = 0.08): void {
    const spanX = Math.max(1e-6, width);
    const spanY = Math.max(1e-6, height);
    const zoomX = this.width / (spanX * (1 + margin * 2));
    const zoomY = this.height / (spanY * (1 + margin * 2));
    this.zoom = Math.max(0.01, Math.min(zoomX, zoomY));
  }

  /** Изменить масштаб с сохранением точки под курсором. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.toWorld(screenX, screenY);
    this.zoom = Math.max(0.5, Math.min(400, this.zoom * factor));
    const after = this.toWorld(screenX, screenY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }
}
