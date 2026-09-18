/**
 * Управление сценой мышью: «удар током», панорама и масштаб.
 *
 * ─── Почему это отдельный модуль ─────────────────────────────────────────
 *
 * До него сцена была ПАССИВНОЙ картинкой: единственным обработчиком на
 * странице был `window.resize`. Камера умела `zoomAt`, ядро умело
 * `setSpot`, но ничего их не вызывало — то есть «функции были, а
 * взаимодействия не было». Именно так это и выглядит для пользователя:
 * интерфейс реагирует, а сама сеть — нет.
 *
 * Здесь события указателя переводятся в ДЕЙСТВИЯ над сетью, и ничего
 * больше: физики тут нет, она в ядре.
 *
 * ─── Разделение кнопок ───────────────────────────────────────────────────
 *
 *   • Левая кнопка — «удар током» (стимул в пятно).
 *   • Средняя кнопка или Shift + левая — панорама.
 *   • Колесо — масштаб с сохранением точки под курсором.
 *
 * Средняя кнопка для панорамы выбрана осознанно: левая занята самым
 * интересным действием — стимулом. Если отдать панораму левой, то
 * «потыкать в нейроны» станет невозможно, а это главное, зачем сюда
 * приходят.
 *
 * ─── Координаты ──────────────────────────────────────────────────────────
 *
 * Указатель приходит в ЭКРАННЫХ пикселях относительно элемента, а сеть
 * живёт в МИРОВЫХ координатах. Перевод делает камера (`toWorld`), и это
 * принципиально: без него удар после масштабирования попадал бы не туда,
 * куда показывает кольцо кисти.
 */

import type { SceneRenderer } from '../render/scene.js';

/** Что контроллер сообщает приложению. */
export interface SceneInputActions {
  /** «Удар током» в мировую точку. */
  onPoke(x: number, y: number): void;
  /** Конец удара (кнопка отпущена) — снять стимул. */
  onPokeEnd(): void;
  /** Пауза / продолжить. */
  onToggleRun(): void;
  /** Один шаг интегрирования. */
  onStep(): void;
  /** Сброс сцены. */
  onReset(): void;
  /** Справка. */
  onHelp(): void;
}

/** Что сейчас тянет указатель. */
type DragMode = 'none' | 'poke' | 'pan';

/** Радиус удара по умолчанию, в мировых единицах. */
export const DEFAULT_BRUSH_RADIUS = 2.5;

/**
 * Управление сценой.
 *
 * `brush` — публичное поле: его читает рендер, чтобы нарисовать кольцо.
 * Это часть контракта между вводом и отрисовкой (тот же приём, что в
 * соседнем phys-lab): рендер не должен знать, ОТКУДА взялось положение
 * кисти.
 */
export class SceneInput {
  /** Текущее положение кисти в мировых координатах. */
  brush: { x: number; y: number; radius: number } | null = null;

  /** Радиус удара, мировые единицы. */
  brushRadius = DEFAULT_BRUSH_RADIUS;

  /**
   * Длительность удара, мс модельного времени.
   *
   * Короткая, но не мгновенная: одиночный шаг (0.5 мс) сдвинул бы
   * потенциал на доли милливольта, и удар выглядел бы «пустым» — тот же
   * класс дефектов, что «нажатие Шаг не давало отклика» в phys-lab.
   */
  pokeDurationMs = 6;

  private readonly element: HTMLElement;
  private readonly renderer: SceneRenderer;
  private readonly actions: SceneInputActions;
  private readonly disposers: Array<() => void> = [];
  private dragging: DragMode = 'none';
  private lastX = 0;
  private lastY = 0;

  constructor(element: HTMLElement, renderer: SceneRenderer, actions: SceneInputActions) {
    this.element = element;
    this.renderer = renderer;
    this.actions = actions;
    this.attach();
  }

  private attach(): void {
    const el = this.element;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ): void => {
      el.addEventListener(type, handler as EventListener, options);
      this.disposers.push(() => el.removeEventListener(type, handler as EventListener));
    };

    on('pointerdown', (event) => this.onPointerDown(event));
    on('pointermove', (event) => this.onPointerMove(event));
    on('pointerup', (event) => this.onPointerUp(event));
    on('pointerleave', () => this.onPointerLeave());
    // `passive: false` обязателен: без него `preventDefault` в обработчике
    // колеса игнорируется, и страница прокручивается вместе с масштабом.
    on('wheel', (event) => this.onWheel(event), { passive: false });
    // Правая кнопка открывала бы контекстное меню поверх сцены.
    on('contextmenu', (event) => event.preventDefault());

    // Клавиши — на `window`, а не на сцене: сцена не получает фокус, и
    // обработчик на ней не сработал бы без предварительного клика.
    const onKey = (event: KeyboardEvent): void => this.onKeyDown(event);
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  /**
   * Горячие клавиши.
   *
   * Латинские и русские варианты — как в соседнем phys-lab: при русской
   * раскладке `event.key` даёт «к», и без второго варианта «R» не работала
   * бы у половины пользователей.
   */
  private onKeyDown(event: KeyboardEvent): void {
    // Не перехватываем ввод в полях: иначе пробел в поле ввода срабатывал
    // бы как «пауза».
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        this.actions.onToggleRun();
        break;
      case 'r':
      case 'R':
      case 'к':
      case 'К':
        this.actions.onReset();
        break;
      case '.':
      case '>':
        this.actions.onStep();
        break;
      case 'h':
      case 'H':
      case 'р':
      case 'Р':
        this.actions.onHelp();
        break;
      default:
        break;
    }
  }

  /** Локальные координаты указателя внутри элемента. */
  private local(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** Экранные координаты элемента → мировые координаты сети. */
  private toWorld(x: number, y: number): { x: number; y: number } {
    return this.renderer.camera.toWorld(x, y);
  }

  private onPointerDown(event: PointerEvent): void {
    // Захват указателя может не сработать (синтетическое событие) и бросить
    // DOMException. Ронять из-за этого обработчик нельзя: вместе с ним
    // терялось бы и само действие.
    try {
      this.element.setPointerCapture?.(event.pointerId);
    } catch {
      // Захват недоступен — работаем без него.
    }

    const { x, y } = this.local(event);
    this.lastX = x;
    this.lastY = y;
    const world = this.toWorld(x, y);

    if (event.button === 1 || event.shiftKey) {
      this.dragging = 'pan';
      return;
    }
    if (event.button !== 0) return;

    this.dragging = 'poke';
    this.brush = { x: world.x, y: world.y, radius: this.brushRadius };
    this.actions.onPoke(world.x, world.y);
  }

  private onPointerMove(event: PointerEvent): void {
    const { x, y } = this.local(event);
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    const world = this.toWorld(x, y);

    // Кисть показывается ВСЕГДА, даже без нажатой кнопки: пользователь
    // должен видеть радиус удара ДО того, как ударит.
    this.brush = { x: world.x, y: world.y, radius: this.brushRadius };

    switch (this.dragging) {
      case 'pan':
        // Панорама: сдвигаем центр камеры против движения указателя —
        // сцена «едет» за курсором, как в картах.
        this.renderer.camera.x -= dx / this.renderer.camera.zoom;
        this.renderer.camera.y -= dy / this.renderer.camera.zoom;
        break;
      case 'poke':
        // Протяжка обжигает непрерывно: удар следует за курсором. Это то,
        // что делает инструмент живым — можно «провести» возбуждение по
        // цепочке нейронов.
        this.actions.onPoke(world.x, world.y);
        break;
      default:
        break;
    }
  }

  private onPointerUp(event: PointerEvent): void {
    const wasPoking = this.dragging === 'poke';
    this.dragging = 'none';
    try {
      this.element.releasePointerCapture?.(event.pointerId);
    } catch {
      // Указатель не был захвачен — освобождать нечего.
    }
    if (wasPoking) this.actions.onPokeEnd();
  }

  private onPointerLeave(): void {
    this.brush = null;
    if (this.dragging === 'poke') {
      this.dragging = 'none';
      this.actions.onPokeEnd();
    }
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const { x, y } = this.local(event);
    // Нормализация: у разных устройств `deltaY` отличается на порядки
    // (строка vs пиксели), поэтому берётся экспонента от величины.
    const factor = Math.exp(-event.deltaY * 0.0012);
    this.renderer.camera.zoomAt(x, y, factor);
  }

  /** Освободить слушатели. */
  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }
}
