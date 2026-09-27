import type { PaneId } from "./ids.js";

type Rect = { width: number; height: number; x: number; y: number };
type LayoutNode =
  | { kind: "leaf"; rect: Rect; pane: number }
  | { kind: "horizontal" | "vertical"; rect: Rect; children: LayoutNode[] };

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

function parseLayout(layout: string): LayoutNode | null {
  if (!/^[0-9a-fA-F]{4},/.test(layout)) return null;
  const parser = new Parser(layout.slice(5));
  const root = parser.parseNode();
  return root && parser.finished() ? root : null;
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
  if (children.length === 1) return children[0] ?? null;
  node.children = children;
  return node;
}

function containsPane(node: LayoutNode, pane: number): boolean {
  return node.kind === "leaf"
    ? node.pane === pane
    : node.children.some((child) => containsPane(child, pane));
}

export function reflowSidepanelAdded(layout: string, pane: PaneId, width: number): string | null {
  const root = parseLayout(layout);
  const target = paneNumber(pane);
  if (!root || target === null || root.kind !== "horizontal" || !Number.isSafeInteger(width)) {
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
  return serialize(root);
}

export function reflowSidepanelRemoved(layout: string, pane: PaneId): string | null {
  const root = parseLayout(layout);
  const target = paneNumber(pane);
  if (!root || target === null || !containsPane(root, target)) return null;

  const rect = { ...root.rect };
  const content = prunePane(root, target);
  if (!content || !scaleHorizontally(content, rect.width, rect.x)) return null;
  return serialize(content);
}
