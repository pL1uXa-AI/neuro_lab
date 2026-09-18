/**
 * Рендер сцены на PixiJS: нейроны, вспышки спайков, связи.
 *
 * ─── Как рисуем ──────────────────────────────────────────────────────────
 *
 * Нейроны — `Particle` в одном `ParticleContainer`. Это не «обычные»
 * спрайты: контейнер собирает их в один батч и обновляет свойства напрямую
 * в типизированных буферах, поэтому тысячи нейронов рисуются за один вызов.
 * Текстура кружка печётся один раз, цвет задаётся через `tint`.
 *
 * Связи рисуются отдельным `Graphics` и обновляются НЕ каждый кадр, а по
 * запросу: при 2500 нейронах и десятках тысяч связей перерисовка линий
 * дороже самой симуляции. Это осознанный размен: связи нужны для статичной
 * картины структуры, а не для анимации.
 *
 * ─── Что важно помнить про этот API ──────────────────────────────────────
 *
 *   1. У `Particle` НЕТ свойства `visible`: скрыть можно нулевым масштабом
 *      или прозрачностью.
 *   2. Список `dynamicProperties` задаёт, какие атрибуты пересчитываются
 *      каждый кадр. Забытый `color` — и нейроны «застынут» в первом цвете.
 *   3. Число частиц в контейнере задаётся при создании: динамически
 *      добавлять их нельзя, поэтому контейнер создаётся под максимум, а
 *      лишние прячутся нулевым масштабом.
 */

import { Application, Graphics, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import type { Network } from '../core/network.js';
import { Camera } from './camera.js';
import { ColorScale, neuronColor, synapseColor, type ColorMode } from './palette.js';

/** Максимальное число нейронов, которое рисует сцена. */
export const MAX_RENDERED = 30000;

/** Сколько связей рисуется (при большем числе картинка превращается в кашу). */
export const MAX_LINKS = 20000;

/** Радиус кружка в текстуре, пиксели. */
const TEXTURE_SIZE = 32;

/** Диаметр нарисованного диска внутри текстуры. */
const CIRCLE_DIAMETER = TEXTURE_SIZE - 1;

/**
 * Сколько импульс остаётся видимым ПОСЛЕ прихода, мс модельного времени.
 *
 * ─── Почему это время в модели, а не в кадрах ────────────────────────────
 *
 * Первая мысль — «держать событие N кадров». Она неверна: при ускорении
 * счёта (автоподстройка делает до 200 шагов за кадр) импульсы, привязанные
 * к кадрам, растягивались бы по модельному времени, и картинка переставала
 * бы соответствовать сети.
 *
 * Здесь длительность задана в МОДЕЛЬНОМ времени, поэтому при паузе след
 * замирает вместе с сетью — ровно как осциллограф.
 *
 * Величина выбрана по измерению: при 2500 нейронах (волна) одно событие
 * летит 0.5–2 мс, а кадр покрывает ≈20 мс модельного времени. Чтобы след
 * читался как «импульс здесь только что прошёл», он должен жить около
 * кадра, но не больше: иначе одновременных отрезков становится столько,
 * что они сливаются в сплошное пятно и структура передачи исчезает.
 */
const PULSE_HOLD_MS = 24;

/**
 * Сколько отрезков импульсов рисовать максимум за кадр.
 *
 * Замерено на волне: 2500 нейронов дают ≈400 событий на шаг, и в окне
 * удержания их накапливаются тысячи. Все рисовать нельзя — получится
 * светящийся диск вместо сети. Прореживание идёт по свежести, поэтому
 * теряются самые старые и слабые следы, а не случайные.
 */
const MAX_PULSES_DRAWN = 4000;

/**
 * Число отрезков, при котором яркость считается «нормальной».
 *
 * Подобрано измерением по двум сценам: на разреженной сети (800 нейронов,
 * 10 % связей) рисуется порядка сотен отрезков, на волне (2500 нейронов,
 * 60 % связей) — около 3300. При 400 разреженная сеть показывается в полную
 * яркость, а волна приглушается примерно втрое: этого достаточно, чтобы
 * следы передач читались на залитой возбуждением решётке, но не превращали
 * кадр в сплошное полотно.
 */
const PULSE_REFERENCE_COUNT = 400;

/**
 * Цвета импульсов.
 *
 * ─── Почему НЕ «тёплый/синий», как у статичных связей ────────────────────
 *
 * Первая версия красила возбуждающий импульс в тёплый жёлтый — по аналогии
 * с `synapseColor`. На кадре волны это оказалось невидимым: сцена в режиме
 * «Спайки» и так залита жёлтым (разряжается почти вся решётка), и жёлтые
 * отрезки на жёлтом фоне сливались в одно пятно.
 *
 * Поэтому импульсы берут оттенки, которых НЕТ в палитре нейронов
 * (`palette.ts`: покой — синевато-серый, спайк — жёлтый, типы — голубой и
 * оранжевый). Бирюзовый и сиреневый не совпадают ни с одним из них, поэтому
 * след передачи читается и на залитой возбуждением сцене.
 */
const PULSE_EXCITATORY = 0x5ce1e6;
/** Цвет тормозного импульса. */
const PULSE_INHIBITORY = 0xb98cff;

/** Настройки отрисовки, меняемые из интерфейса. */
export interface RenderOptions {
  colorMode: ColorMode;
  /** Показывать связи. */
  showLinks: boolean;
  /** Показывать сетку координат (для пространственных сцен). */
  showGrid: boolean;
  /** Масштаб нейрона на экране. */
  neuronScale: number;
  /**
   * Показывать проход импульсов по синапсам.
   *
   * Отдельно от `showLinks`: статичная паутина связей отвечает на вопрос
   * «кто с кем соединён», а бегущие импульсы — «куда идёт возбуждение
   * сейчас». Это разные вопросы, и включать их вместе не всегда нужно.
   */
  showPulses: boolean;
}

/** Статистика последнего кадра — для интерфейса и проверок. */
export interface RenderStats {
  /** Сколько нейронов нарисовано. */
  drawn: number;
  /** Сколько нейронов было «в кадре» (вспышка > 0). */
  flashes: number;
  /** Сколько связей нарисовано. */
  links: number;
  /** Сколько отрезков импульсов нарисовано за кадр. */
  pulses: number;
  /** Время кадра, мс. */
  frameMs: number;
}

/** Сцена: нейроны, связи, сетка. */
export class SceneRenderer {
  readonly app: Application;
  readonly camera = new Camera();

  options: RenderOptions = {
    colorMode: 'potential',
    showLinks: true,
    showGrid: true,
    neuronScale: 1,
    showPulses: true,
  };

  private readonly spriteTexture: Texture;
  private readonly neurons: ParticleContainer;
  private readonly linkLayer = new Graphics();
  private readonly gridLayer = new Graphics();
  /** Слой бегущих импульсов: отдельно от связей, обновляется каждый кадр. */
  private readonly pulseLayer = new Graphics();
  /** Кольцо кисти: показывает, куда попадёт «удар током». */
  private readonly brushLayer = new Graphics();
  private readonly particles: Particle[] = [];
  private linksDirty = true;
  private readonly potentialScale = new ColorScale();
  private readonly rateScale = new ColorScale();
  /** Буфер значений для подбора квантилей (переиспользуется). */
  private readonly sampleBuffer: number[] = [];
  private lastStats: RenderStats = { drawn: 0, flashes: 0, links: 0, pulses: 0, frameMs: 0 };

  constructor(app: Application) {
    this.app = app;

    // Текстура кружка: печётся один раз, потом только tint.
    const shape = new Graphics();
    shape.circle(TEXTURE_SIZE / 2, TEXTURE_SIZE / 2, CIRCLE_DIAMETER / 2);
    shape.fill({ color: 0xffffff });
    this.spriteTexture = app.renderer.generateTexture(shape);

    this.gridLayer.alpha = 0.25;
    this.linkLayer.alpha = 0.5;

    this.neurons = new ParticleContainer({
      // Потолок задаётся при создании: добавить частицы позже нельзя.
      dynamicProperties: {
        position: true,
        scale: true,
        color: true,
        alpha: true,
      },
    });

    app.stage.addChild(this.gridLayer);
    app.stage.addChild(this.linkLayer);
    app.stage.addChild(this.neurons);
    // Импульсы — ПОВЕРХ нейронов, но ПОД кольцом кисти.
    //
    // Сначала слой стоял под нейронами «чтобы не закрывать сому». На
    // практике это сделало его почти невидимым: в плотной решётке диаметр
    // точки равен 0.9 шага между соседями, и отрезок между двумя точками
    // закрыт ими обеими, оставляя лишь узкую щель. След передачи
    // (alpha ≤ 0.45) в этой щели не читается — то есть визуализация была
    // формально включена и фактически бесполезна.
    app.stage.addChild(this.pulseLayer);
    app.stage.addChild(this.brushLayer);

    // Границы задаются сразу: `ParticleContainer` их не вычисляет сам, и без
    // этого `extract.pixels` вернул бы кадр 1×1 (см. `updateBoundsArea`).
    this.updateBoundsArea();

    for (let i = 0; i < MAX_RENDERED; i++) {
      const particle = new Particle({
        texture: this.spriteTexture,
        // Нулевой масштаб = «не рисовать»: у Particle нет `visible`.
        scaleX: 0,
        scaleY: 0,
        anchorX: 0.5,
        anchorY: 0.5,
      });
      this.particles.push(particle);
      this.neurons.addParticle(particle);
    }
  }

  /** Подогнать размер рендера под контейнер. */
  resize(width: number, height: number): void {
    this.camera.width = width;
    this.camera.height = height;
    this.app.renderer.resize(width, height);
    this.updateBoundsArea();
    // Смена размера меняет и положение нейронов на экране, поэтому связи
    // нужно нарисовать заново: иначе линии остаются от прежней геометрии.
    this.linksDirty = true;
  }

  /**
   * Задать границы контейнера нейронов.
   *
   * ─── Зачем это обязательно ──────────────────────────────────────────────
   *
   * `ParticleContainer` НЕ вычисляет свои границы: Pixi прямо требует
   * задать `boundsArea` вручную, потому что обход тысяч частиц ради
   * границ стоил бы дороже самой отрисовки.
   *
   * Без этого `boundsArea` остаётся единичным, и всё, что зависит от
   * границ, работает неправильно: система извлечения (`extract.pixels`)
   * возвращает кадр размером 1×1 пиксель. Обнаружено при первой версии
   * витрины: она честно сообщала «0 % светящихся» для всех сцен кроме
   * волны — а у волны размер задавал слой сетки, который границы считает.
   */
  private updateBoundsArea(): void {
    this.neurons.boundsArea = new Rectangle(0, 0, this.camera.width, this.camera.height);
  }

  /** Пометить связи как требующие перерисовки (после смены сцены или STDP). */
  invalidateLinks(): void {
    this.linksDirty = true;
  }

  /** Обновить состояние камеры и подготовить буферы. */
  private prepare(network: Network): void {
    const count = Math.min(network.params.count, MAX_RENDERED);

    // Границы для шкал: берём выборку, а не все значения, чтобы не тратить
    // кадр на сортировку десятков тысяч чисел.
    const stride = Math.max(1, Math.floor(count / 2000));
    this.sampleBuffer.length = 0;
    for (let i = 0; i < count; i += stride) this.sampleBuffer.push(network.state.v[i]);
    this.potentialScale.fit(this.sampleBuffer, { lowQ: 0.02, highQ: 0.995 });

    this.sampleBuffer.length = 0;
    let maxSpikes = 1;
    for (let i = 0; i < count; i += stride) {
      if (network.state.spikeCount[i] > maxSpikes) maxSpikes = network.state.spikeCount[i];
    }
    this.rateScale.setRange(0, maxSpikes);
  }

  /**
   * Радиус облака нейронов на экране, в пикселях.
   *
   * Считается по крайним нейронам относительно центра облака, а не по
   * камере: камера смотрит на область с полями, и её размер не говорит,
   * насколько плотно уложены точки. Проходится выборка, а не все нейроны:
   * для оценки масштаба достаточно сотни замеров.
   */
  private screenRadiusPx(network: Network): number {
    const count = Math.min(network.params.count, MAX_RENDERED);
    if (count <= 1) return this.camera.height * 0.25;

    // Центр облака в мировых координатах — по крайним значениям.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const stride = Math.max(1, Math.floor(count / 400));
    for (let i = 0; i < count; i += stride) {
      if (network.x[i] < minX) minX = network.x[i];
      if (network.x[i] > maxX) maxX = network.x[i];
      if (network.y[i] < minY) minY = network.y[i];
      if (network.y[i] > maxY) maxY = network.y[i];
    }
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centre = this.camera.toScreen(centreX, centreY);

    let radius = 0;
    for (let i = 0; i < count; i += stride) {
      const screen = this.camera.toScreen(network.x[i], network.y[i]);
      const distance = Math.hypot(screen.x - centre.x, screen.y - centre.y);
      if (distance > radius) radius = distance;
    }
    return Math.max(1, radius);
  }

  /** Отрисовка одного кадра. */
  render(network: Network, options: { gridSpan?: number } = {}): RenderStats {
    const startedAt = performance.now();
    this.prepare(network);
    const stats = this.drawNeurons(network);
    if (options.gridSpan !== undefined) this.drawGrid(options.gridSpan);

    if (this.options.showLinks && this.linksDirty) {
      stats.links = this.drawLinks(network);
      this.linksDirty = false;
    } else if (!this.options.showLinks) {
      this.linkLayer.visible = false;
      stats.links = 0;
    }

    stats.pulses = this.drawPulses(network);

    stats.frameMs = performance.now() - startedAt;
    this.lastStats = stats;
    return stats;
  }

  /**
   * Нарисовать проход импульсов по синапсам.
   *
   * ─── Что здесь честно, а что упрощено ───────────────────────────────────
   *
   * Каждое событие следа — это РЕАЛЬНАЯ передача: спайк вышел из `from` в
   * `departMs` и придёт в `to` в `arriveMs` (время взято из фактического
   * слота буфера задержек, см. `PulseTrace.recordFrom`). Поэтому положение
   * точки на отрезке в момент `nowMs` — не анимация, а вычисление:
   * `t = (nowMs − depart) / (arrive − depart)`.
   *
   * Ограничение, которое нужно знать: при обычной скорости счёта импульс
   * пролетает за 0.5–2 мс, а кадр покрывает ≈20 мс модельного времени.
   * Значит «увидеть летящую точку» на коротких связях невозможно в
   * принципе: она выходит и приходит внутри одного кадра. Видно её будет
   * на длинных задержках — в кольце и слоистой сети, — а на коротких
   * остаётся вспышка самой связи. Это не дефект отрисовки, а измеренное
   * соотношение времён, и врать об этом картинкой не нужно.
   */
  private drawPulses(network: Network): number {
    this.pulseLayer.clear();
    if (!this.options.showPulses) {
      this.pulseLayer.visible = false;
      return 0;
    }
    this.pulseLayer.visible = true;

    const nowMs = network.state.time;
    const active = network.pulses.countActive(nowMs, PULSE_HOLD_MS);
    if (active === 0) return 0;

    // Прореживание по свежести: если событий больше предела, шагаем по ним.
    const stride = Math.max(1, Math.ceil(active / MAX_PULSES_DRAWN));
    const count = Math.min(network.params.count, MAX_RENDERED);
    const drawnEstimate = Math.max(1, Math.ceil(active / stride));

    // ─── Яркость падает с плотностью: «чернил» на кадр ограничено ────────
    //
    // Измерено на волне: при разряде всей решётки в окне удержания
    // накапливается ~3300 отрезков, и при постоянной яркости сцена
    // превращалась в сплошное бирюзовое полотно — след передачи переставал
    // что-либо показывать. Это ровно та же ошибка, что «вспышка не успевала
    // погаснуть» в дефекте 24: показательна не яркость отдельного элемента,
    // а сумма по кадру.
    //
    // Поэтому яркость обратно пропорциональна корню из числа отрезков: на
    // разреженной сети (десятки событий) каждый виден отчётливо, на
    // лавине — все приглушены, но структура потока читается.
    const density = Math.sqrt(drawnEstimate / PULSE_REFERENCE_COUNT);
    const densityAlpha = Math.min(1, 1 / Math.max(1, density));

    let drawn = 0;
    network.pulses.forEachActive(
      nowMs,
      PULSE_HOLD_MS,
      (from, to, t, weight, ageMs) => {
        if (from >= count || to >= count) return;
        const a = this.camera.toScreen(network.x[from], network.y[from]);
        const b = this.camera.toScreen(network.x[to], network.y[to]);

        // Яркость: свежие и ещё летящие — заметнее. Множитель подобран
        // визуально по витринному кадру волны: при 0.45 след читался, но
        // был бледным на залитой возбуждением сцене.
        const recency = 1 - Math.min(1, Math.max(0, ageMs) / PULSE_HOLD_MS);
        const alpha = Math.max(0.05, 0.85 * recency * densityAlpha);

        if (t < 1) {
          // Импульс в пути: отрезок от выхода до текущего положения.
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          this.pulseLayer.moveTo(a.x, a.y);
          this.pulseLayer.lineTo(x, y);
          this.pulseLayer.stroke({
            width: 1.6,
            color: weight >= 0 ? PULSE_EXCITATORY : PULSE_INHIBITORY,
            alpha,
          });
          // И головка импульса — точка: так «летящее» видно даже на
          // коротком отрезке, где линия ещё почти нулевой длины.
          this.pulseLayer.circle(x, y, 1.8);
          this.pulseLayer.fill({
            color: weight >= 0 ? PULSE_EXCITATORY : PULSE_INHIBITORY,
            alpha: Math.min(1, alpha * 2.2),
          });
          drawn += 1;
          return;
        }

        // Импульс уже дошёл: вспышка всей связи — след только что
        // прошедшей передачи.
        this.pulseLayer.moveTo(a.x, a.y);
        this.pulseLayer.lineTo(b.x, b.y);
        this.pulseLayer.stroke({
          width: 1.1,
          color: weight >= 0 ? PULSE_EXCITATORY : PULSE_INHIBITORY,
          alpha: alpha * 0.6,
        });
        drawn += 1;
      },
      stride,
    );

    return drawn;
  }

  /**
   * Показать кольцо кисти («куда ударит током»).
   *
   * `brush` в МИРОВЫХ координатах, как и всё остальное в сцене; перевод в
   * экранные делает камера. Радиус тоже мировой: он должен расти при
   * приближении, иначе кольцо перестанет показывать настоящий размер
   * захвата.
   */
  setBrush(brush: { x: number; y: number; radius: number } | null): void {
    this.brushLayer.clear();
    if (!brush) return;
    const screen = this.camera.toScreen(brush.x, brush.y);
    const radiusPx = brush.radius * this.camera.zoom;
    this.brushLayer.circle(screen.x, screen.y, Math.max(2, radiusPx));
    this.brushLayer.stroke({ width: 1.5, color: 0xffd166, alpha: 0.75 });
    this.brushLayer.circle(screen.x, screen.y, 2);
    this.brushLayer.fill({ color: 0xffd166, alpha: 0.9 });
  }

  /** Нарисовать нейроны и получить статистику. */
  private drawNeurons(network: Network): RenderStats {
    const count = Math.min(network.params.count, MAX_RENDERED);
    const scale = this.options.neuronScale;
    // ─── Размер нейрона выводится из РАССТОЯНИЯ между соседями ───────────
    //
    // Первая версия брала фиксированный радиус в мировых единицах и
    // умножала на зум — сеть сливалась в пятно. Вторая считала площадь
    // кадра на нейрон: на 800 нейронов это давало диаметр 36 пикселей при
    // реальном расстоянии между соседями 17.5, то есть частицы
    // перекрывались вдвое и получался сплошной блин (видно на витринном
    // кадре).
    //
    // Здесь расстояние считается по ФАКТИЧЕСКОМУ разбросу нейронов на
    // экране: берётся наибольший экранный радиус облака, и из него —
    // средний шаг между соседями на диске. Радиус частицы равен половине
    // шага с небольшим зазором, поэтому точки соприкасаются, но не
    // сливаются.
    const cloudRadiusPx = this.screenRadiusPx(network);
    // Площадь диска πr², на ней count точек: шаг ≈ 2r/√count.
    const spacingPx = (2 * cloudRadiusPx) / Math.sqrt(Math.max(1, count));
    const baseRadius = Math.max(0.7, Math.min(12, spacingPx * 0.45));
    let flashes = 0;

    const [minV, maxV] = this.potentialScale.range;
    const spanV = Math.max(1e-6, maxV - minV);

    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];
      if (i >= count) {
        particle.scaleX = 0;
        particle.scaleY = 0;
        continue;
      }

      const screen = this.camera.toScreen(network.x[i], network.y[i]);
      particle.x = screen.x;
      particle.y = screen.y;

      const flash = network.state.flash[i];
      if (flash > 0) flashes += 1;

      const potential01 = (network.state.v[i] - minV) / spanV;
      const rate01 = this.rateScale.normalise(network.state.spikeCount[i]);

      // Радиус уже в ПИКСЕЛЯХ (см. вывод `baseRadius`), поэтому домножать
      // его на зум нельзя: это удвоило бы масштабирование и вернуло
      // слипание.
      //
      // Вспышка увеличивает точку лишь в 1.5 раза. Было 2.8 — и в живой
      // сети, где спайкует большинство нейронов, ВСЕ частицы оказывались
      // раздутыми, сеть превращалась в сплошной блин, а цвет — в ровный
      // жёлтый: вспышки перекрывали и раскраску по потенциалу, и зазоры
      // между точками.
      const radiusPx = baseRadius * (1 + flash * 0.5) * scale;
      particle.scaleX = radiusPx / (TEXTURE_SIZE / 2);
      particle.scaleY = particle.scaleX;
      particle.tint = neuronColor({
        mode: this.options.colorMode,
        potential01,
        flash,
        inhibitory: network.state.inhibitory[i] === 1,
        rate01,
      });
      particle.alpha = 1;
    }

    this.neurons.visible = true;
    // ─── Почему нужен явный update ───────────────────────────────────────
    //
    // У `ParticleContainer` свойства частиц (`x`, `y`, `scaleX`, `tint`)
    // пишутся в типизированные буферы, но батч пересобирается только при
    // изменении САМОГО контейнера. Прямая запись в частицы такого сигнала
    // не даёт, и на экране остаётся картинка первого кадра — визуально
    // «рисуется только один нейрон».
    //
    // Измерено: все 800 частиц имели правильные координаты и масштаб, но
    // на скриншоте был один кружок.
    this.neurons.update();
    return { drawn: count, flashes, links: 0, pulses: 0, frameMs: 0 };
  }

  /** Нарисовать связи (перерисовывается только при их изменении). */
  private drawLinks(network: Network): number {
    this.linkLayer.clear();
    this.linkLayer.visible = true;

    const matrix = network.synapses;
    if (matrix.synapseCount === 0) return 0;

    // Максимальная величина веса — для нормировки цвета. Берётся по
    // выборке: полный обход десятков тысяч связей на кадр не нужен.
    const stride = Math.max(1, Math.floor(matrix.synapseCount / MAX_LINKS));
    let maxMagnitude = 1e-9;
    for (let s = 0; s < matrix.synapseCount; s += stride) {
      const magnitude = Math.abs(matrix.weight[s]);
      if (magnitude > maxMagnitude) maxMagnitude = magnitude;
    }

    let drawn = 0;
    for (let i = 0; i < matrix.count && i < MAX_RENDERED; i++) {
      const from = this.camera.toScreen(network.x[i], network.y[i]);
      for (let s = matrix.rowPtr[i]; s < matrix.rowPtr[i + 1]; s += stride) {
        if (drawn >= MAX_LINKS) break;
        const j = matrix.colIdx[s];
        if (j >= MAX_RENDERED) continue;
        const to = this.camera.toScreen(network.x[j], network.y[j]);
        this.linkLayer.moveTo(from.x, from.y);
        this.linkLayer.lineTo(to.x, to.y);
        this.linkLayer.stroke({
          width: 1,
          color: synapseColor(matrix.weight[s], maxMagnitude),
          alpha: 0.35,
        });
        drawn += 1;
      }
    }
    return drawn;
  }

  /** Нарисовать сетку координат. */
  private drawGrid(span: number): void {
    this.gridLayer.clear();
    this.gridLayer.visible = this.options.showGrid;
    if (!this.options.showGrid) return;

    const step = span > 40 ? 10 : span > 12 ? 5 : 1;
    for (let x = 0; x <= span; x += step) {
      const from = this.camera.toScreen(x, 0);
      const to = this.camera.toScreen(x, span);
      this.gridLayer.moveTo(from.x, from.y);
      this.gridLayer.lineTo(to.x, to.y);
    }
    for (let y = 0; y <= span; y += step) {
      const from = this.camera.toScreen(0, y);
      const to = this.camera.toScreen(span, y);
      this.gridLayer.moveTo(from.x, from.y);
      this.gridLayer.lineTo(to.x, to.y);
    }
    this.gridLayer.stroke({ width: 1, color: 0x22303f, alpha: 1 });
  }

  /** Статистика последнего кадра. */
  get stats(): RenderStats {
    return this.lastStats;
  }
}
