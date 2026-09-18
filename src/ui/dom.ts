/**
 * Мини-хелпер для построения DOM.
 *
 * Фреймворк здесь не нужен: интерфейс — это десяток панелей с редкими
 * обновлениями, а весь горячий рендер живёт в Pixi. Свой `h()` оказался
 * дешевле по весу и избавил от согласования состояния между фреймворком и
 * сценой — тот же выбор, что в phys-lab и logic-lab.
 *
 * Содержимое задаётся ОДНИМ способом: либо дочерними аргументами, либо
 * свойством `text`/`html`. Если задать оба, применяется `text`/`html` —
 * иначе текст задваивался бы.
 */

type Child = Node | string | number | null | undefined | false;

/** Создание элемента. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> & { class?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  const hasOwnContent = props['text'] !== undefined || props['html'] !== undefined;
  if (hasOwnContent) {
    if (props['html'] !== undefined) el.innerHTML = String(props['html']);
    else el.textContent = String(props['text']);
  } else {
    append(el, children);
  }
  return el;
}

function applyProps(el: HTMLElement, props: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    switch (key) {
      case 'class':
        el.className = String(value);
        break;
      case 'style':
        if (typeof value === 'string') el.style.cssText = value;
        else if (typeof value === 'object') Object.assign(el.style, value);
        break;
      case 'dataset':
        for (const [dataKey, dataValue] of Object.entries(value as Record<string, unknown>)) {
          el.dataset[dataKey] = String(dataValue);
        }
        break;
      case 'text':
      case 'html':
        // Обрабатываются в h(): содержимое задаётся один раз.
        break;
      case 'on':
        for (const [event, handler] of Object.entries(value as Record<string, EventListener>)) {
          el.addEventListener(event, handler);
        }
        break;
      case 'value':
        (el as HTMLInputElement).value = String(value);
        break;
      case 'checked':
      case 'disabled':
      case 'selected':
        (el as unknown as Record<string, unknown>)[key] = Boolean(value);
        break;
      default:
        el.setAttribute(key, String(value));
        break;
    }
  }
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Заменить содержимое элемента. */
export function setContent(el: HTMLElement, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Короткая форма запроса элемента по селектору. */
export function qs<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T | null {
  return root.querySelector<T>(selector);
}

/** Требовательный вариант: бросает, если элемента нет. */
export function need<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Элемент не найден: ${selector}`);
  return el;
}

/** Кнопка с единым оформлением. */
export function button(
  label: string,
  onClick: () => void,
  extra: Record<string, unknown> = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      class: `btn ${String(extra['class'] ?? '')}`.trim(),
      type: 'button',
      on: { click: onClick },
      ...extra,
    },
    label,
  );
}

/**
 * Ползунок с подписью и числовым значением.
 *
 * Возвращает способ обновить отображение снаружи: пресет или уровень может
 * изменить параметр помимо ползунка, и подпись обязана это показать.
 * Без этого интерфейс расходится с состоянием — незаметно и надолго.
 */
export interface RangeControl {
  root: HTMLElement;
  set(value: number): void;
  readonly input: HTMLInputElement;
}

export function rangeControl(options: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (value: number) => string;
  onInput: (value: number) => void;
}): RangeControl {
  const format = options.format ?? ((value: number) => String(value));
  const output = h('output', { class: 'field__value' }, format(options.value));
  const input = h('input', {
    class: 'range',
    type: 'range',
    min: options.min,
    max: options.max,
    step: options.step,
    value: options.value,
    on: {
      input: (event: Event) => {
        const value = Number((event.target as HTMLInputElement).value);
        output.textContent = format(value);
        options.onInput(value);
      },
    },
  });
  const root = h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label' }, options.label),
    input,
    output,
  );
  return {
    root,
    input,
    set(value: number): void {
      input.value = String(value);
      output.textContent = format(value);
    },
  };
}

/** Переключатель: группа кнопок с одним выбранным значением. */
export interface ToggleControl<T extends string> {
  root: HTMLElement;
  set(value: T): void;
}

export function toggleControl<T extends string>(options: {
  label: string;
  items: ReadonlyArray<{ id: T; label: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
}): ToggleControl<T> {
  let current = options.value;
  const buttons = new Map<T, HTMLButtonElement>();
  const root = h(
    'div',
    { class: 'field field--toggle' },
    h('span', { class: 'field__label' }, options.label),
  );
  const group = h('div', { class: 'toggle' });
  for (const item of options.items) {
    const btn = h(
      'button',
      {
        class: 'toggle__item',
        type: 'button',
        title: item.title ?? '',
        on: {
          click: () => {
            current = item.id;
            sync();
            options.onChange(item.id);
          },
        },
      },
      item.label,
    );
    buttons.set(item.id, btn);
    group.append(btn);
  }
  root.append(group);

  function sync(): void {
    for (const [id, btn] of buttons) btn.classList.toggle('toggle__item--on', id === current);
  }
  sync();

  return {
    root,
    set(value: T): void {
      current = value;
      sync();
    },
  };
}

/** Флажок. */
export function checkbox(options: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    checked: options.checked,
    on: {
      change: (event: Event) => options.onChange((event.target as HTMLInputElement).checked),
    },
  });
  return h('label', { class: 'field field--check' }, input, h('span', {}, options.label));
}

/** Строка «подпись — значение» для сводок. */
export function statRow(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('span', { class: 'stat__label' }, label),
    h('span', { class: 'stat__value', 'data-stat': label }, value),
  );
}

/** Панель со сворачиваемым заголовком. */
export function section(title: string, ...children: Child[]): HTMLElement {
  const body = h('div', { class: 'section__body' }, ...children);
  const header = h(
    'button',
    {
      class: 'section__header',
      type: 'button',
      on: {
        click: () => {
          const collapsed = body.classList.toggle('section__body--collapsed');
          header.classList.toggle('section__header--collapsed', collapsed);
        },
      },
    },
    title,
  );
  return h('section', { class: 'section' }, header, body);
}

/** Канвас для графиков и осциллографа. */
export function canvas(className: string): HTMLCanvasElement {
  return h('canvas', { class: className });
}
