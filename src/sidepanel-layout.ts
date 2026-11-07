import type { PaneId } from "./ids.js";

type Rect = { width: number; height: number; x: number; y: number };
/** A tmux 3.8+ JSON layout cell, kept whole so fields murmur ignores survive a write-back. */
type JsonCell = Record<string, unknown>;
type LayoutNode =
  | { kind: "leaf"; rect: Rect; pane: number; cell?: JsonCell }
  | { kind: "horizontal" | "vertical"; rect: Rect; children: LayoutNode[]; cell?: JsonCell };
/** A parsed window layout and how to write a reflowed tree back in the form it was read. */
type Parsed = { root: LayoutNode; write: (root: LayoutNode) => string };

class Parser {
  private position = 0;

  constructor(private readonly input: string) {}

  finished(): boolean {
    return this.position === this.input.length;
  }

  parseNode(): LayoutNode | null {
    const rect = this.parseRect();
    if (!rect) return null;

    const next = this.input[this.position];
    if (next === ",") {
      this.position += 1;
      const pane = this.parseNumber(true);
      return pane === null ? null : { kind: "leaf", rect, pane };
    }
    if (next !== "{" && next !== "[") return null;

    this.position += 1;
    const children: LayoutNode[] = [];
    const close = next === "{" ? "}" : "]";
    while (true) {
      const child = this.parseNode();
      if (!child) return null;
      children.push(child);
      const separator = this.input[this.position];
      this.position += 1;
      if (separator === close) break;
      if (separator !== ",") return null;
    }
    if (children.length < 2) return null;
    return { kind: next === "{" ? "horizontal" : "vertical", rect, children };
  }

  private parseRect(): Rect | null {
    const width = this.parseNumber();
    if (width === null || !this.consume("x")) return null;
    const height = this.parseNumber();
    if (height === null || !this.consume(",")) return null;
    const x = this.parseNumber(true);
    if (x === null || !this.consume(",")) return null;
    const y = this.parseNumber(true);
    if (y === null) return null;
    return { width, height, x, y };
  }

  private parseNumber(allowZero = false): number | null {
    const start = this.position;
    while (/\d/.test(this.input[this.position] ?? "")) this.position += 1;
    if (start === this.position) return null;
    const value = Number(this.input.slice(start, this.position));
    return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) ? value : null;
  }

  private consume(expected: string): boolean {
    if (this.input[this.position] !== expected) return false;
    this.position += 1;
    return true;
  }
}

/**
 * `#{window_layout}` in either form tmux prints: the `csum,WxH,x,y{...}` string
 * of tmux before 3.8, or 3.8's JSON subset (`{"V":2,"L":{...}}`), which tmux
 * 3.8 gives every client but a control-mode one without new-layouts.
 * select-layout accepts both, so the reflow is written back in the form read.
 */
function parseLayout(layout: string): Parsed | null {
  if (layout.startsWith("{")) return parseJsonLayout(layout);
  if (!/^[0-9a-fA-F]{4},/.test(layout)) return null;
  const parser = new Parser(layout.slice(5));
  const root = parser.parseNode();
  return root && parser.finished() ? { root, write: serialize } : null;
}

function parseJsonLayout(layout: string): Parsed | null {
  let doc: unknown;
  try {
    doc = JSON.parse(layout);
  } catch {
    return null;
  }
  if (!isObject(doc) || doc.V !== 2 || !isObject(doc.L)) return null;
  const root = jsonNode(doc.L);
  if (!root) return null;
  return { root, write: (node) => JSON.stringify({ ...doc, L: writeJsonNode(node) }) };
}

function isObject(value: unknown): value is JsonCell {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonNumber(value: unknown, allowZero: boolean): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (allowZero ? value >= 0 : value > 0)
    ? value
    : null;
}

function jsonNode(cell: JsonCell): LayoutNode | null {
  const width = jsonNumber(cell.w, false);
  const height = jsonNumber(cell.h, false);
  const x = jsonNumber(cell.x, true);
  const y = jsonNumber(cell.y, true);
  if (width === null || height === null || x === null || y === null) return null;
  const rect = { width, height, x, y };
  if (cell.t === "p") {
    const pane = typeof cell.I === "string" ? paneNumber(cell.I as PaneId) : null;
    return pane === null ? null : { kind: "leaf", rect, pane, cell };
  }
  if ((cell.t !== "h" && cell.t !== "v") || !Array.isArray(cell.c) || cell.c.length < 2) {
    return null;
  }
  const children: LayoutNode[] = [];
  for (const child of cell.c) {
    const node = isObject(child) ? jsonNode(child) : null;
    if (!node) return null;
    children.push(node);
  }
  return { kind: cell.t === "h" ? "horizontal" : "vertical", rect, children, cell };
}

function writeJsonNode(node: LayoutNode): JsonCell {
  const { width: w, height: h, x, y } = node.rect;
  const out: JsonCell = { ...node.cell, w, h, x, y };
  if (node.kind === "leaf") return out;
  return { ...out, c: node.children.map(writeJsonNode) };
}

function paneNumber(pane: PaneId): number | null {
  if (!/^%\d+$/.test(pane)) return null;
  const value = Number(pane.slice(1));
  return Number.isSafeInteger(value) ? value : null;
}

function writeNode(node: LayoutNode): string {
  const { width, height, x, y } = node.rect;
  const prefix = `${width}x${height},${x},${y}`;
  if (node.kind === "leaf") return `${prefix},${node.pane}`;
  const brackets = node.kind === "horizontal" ? ["{", "}"] : ["[", "]"];
  return `${prefix}${brackets[0]}${node.children.map(writeNode).join(",")}${brackets[1]}`;
}

function checksum(body: string): string {
  let sum = 0;
  for (const byte of Buffer.from(body)) {
    sum = ((sum >>> 1) | ((sum & 1) << 15)) + byte;
    sum &= 0xffff;
  }
  return sum.toString(16).padStart(4, "0");
}

function serialize(root: LayoutNode): string {
  const body = writeNode(root);
  return `${checksum(body)},${body}`;
}

function proportionalLengths(oldLengths: number[], available: number): number[] | null {
  if (oldLengths.length === 0 || available < oldLengths.length) return null;
  const total = oldLengths.reduce((sum, length) => sum + length, 0);
  if (!Number.isSafeInteger(total) || total <= 0) return null;

  let remaining = available;
  return oldLengths.map((length, index) => {
    if (index === oldLengths.length - 1) return remaining;
    const scaled = Math.max(1, Math.round((length / total) * available));
    const reserved = oldLengths.length - index - 1;
    const result = Math.min(scaled, remaining - reserved);
    remaining -= result;
    return result;
  });
}

function scaleHorizontally(node: LayoutNode, width: number, x: number): boolean {
  if (width <= 0 || !Number.isSafeInteger(width) || !Number.isSafeInteger(x)) return false;
  node.rect.width = width;
  node.rect.x = x;

  if (node.kind === "leaf") return true;
  if (node.kind === "vertical") {
    return node.children.every((child) => scaleHorizontally(child, width, x));
  }

  const available = width - (node.children.length - 1);
  const lengths = proportionalLengths(
    node.children.map((child) => child.rect.width),
    available,
  );
  if (!lengths) return false;
  let childX = x;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const length = lengths[index];
    if (!child || length === undefined || !scaleHorizontally(child, length, childX)) return false;
    childX += length + 1;
  }
  return true;
}

function scaleVertically(node: LayoutNode, height: number, y: number): boolean {
  if (height <= 0 || !Number.isSafeInteger(height) || !Number.isSafeInteger(y)) return false;
  node.rect.height = height;
  node.rect.y = y;
  if (node.kind === "leaf") return true;
  if (node.kind === "horizontal") {
    return node.children.every((child) => scaleVertically(child, height, y));
  }

  const available = height - (node.children.length - 1);
  const lengths = proportionalLengths(
    node.children.map((child) => child.rect.height),
    available,
  );
  if (!lengths) return false;
  let childY = y;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const length = lengths[index];
    if (!child || length === undefined || !scaleVertically(child, length, childY)) return false;
    childY += length + 1;
  }
  return true;
}

function prunePane(node: LayoutNode, pane: number): LayoutNode | null {
  if (node.kind === "leaf") return node.pane === pane ? null : node;
  const children = node.children
    .map((child) => prunePane(child, pane))
    .filter((child): child is LayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) {
    const survivor = children[0];
    if (!survivor) return null;
    return scaleHorizontally(survivor, node.rect.width, node.rect.x) &&
      scaleVertically(survivor, node.rect.height, node.rect.y)
      ? survivor
      : null;
  }
  node.children = children;
  return node;
}

function containsPane(node: LayoutNode, pane: number): boolean {
  return node.kind === "leaf"
    ? node.pane === pane
    : node.children.some((child) => containsPane(child, pane));
}

export function reflowSidepanelAdded(layout: string, pane: PaneId, width: number): string | null {
  const parsed = parseLayout(layout);
  const root = parsed?.root;
  const target = paneNumber(pane);
  if (
    !parsed ||
    !root ||
    target === null ||
    root.kind !== "horizontal" ||
    !Number.isSafeInteger(width)
  ) {
    return null;
  }

  const panelIndex = root.children.findIndex(
    (child) => child.kind === "leaf" && child.pane === target,
  );
  if (panelIndex < 0) return null;
  const panel = root.children[panelIndex];
  if (!panel) return null;
  const content = root.children.filter((_, index) => index !== panelIndex);
  const available = root.rect.width - width - content.length;
  const lengths = proportionalLengths(
    content.map((child) => child.rect.width),
    available,
  );
  if (width <= 0 || !lengths || !scaleHorizontally(panel, width, root.rect.x)) return null;
  if (!scaleVertically(panel, root.rect.height, root.rect.y)) return null;

  let x = root.rect.x + width + 1;
  for (let index = 0; index < content.length; index += 1) {
    const child = content[index];
    const length = lengths[index];
    if (!child || length === undefined || !scaleHorizontally(child, length, x)) return null;
    x += length + 1;
  }
  root.children = [panel, ...content];
  return parsed.write(root);
}

export function reflowSidepanelRemoved(layout: string, pane: PaneId): string | null {
  const parsed = parseLayout(layout);
  const target = paneNumber(pane);
  if (!parsed || target === null || !containsPane(parsed.root, target)) return null;

  const rect = { ...parsed.root.rect };
  const content = prunePane(parsed.root, target);
  if (!content || !scaleHorizontally(content, rect.width, rect.x)) return null;
  return parsed.write(content);
}
