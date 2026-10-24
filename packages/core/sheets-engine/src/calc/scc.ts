/**
 * Strongly connected components of the dependents graph, Tarjan's algorithm
 * run iteratively (no recursion, so a million-long chain of formulas is fine).
 *
 * Edges run from a formula to the formulas that read it. Tarjan finishes a
 * component only after every component reachable from it, i.e. after
 * everything that reads it; the reversed finish order is therefore the order
 * to evaluate in.
 */
export class SccWalker {
  private readonly index = new Map<number, number>();
  private readonly low = new Map<number, number>();
  private readonly onStack = new Set<number>();
  private readonly stack: number[] = [];
  private readonly selfLoops = new Set<number>();
  private readonly components: number[][] = [];
  private counter = 0;

  constructor(private readonly dependents: (key: number) => number[]) {}

  visit(start: number): void {
    if (this.index.has(start)) return;
    const frames = [this.open(start)];
    while (frames.length) {
      const top = frames[frames.length - 1]!;
      if (top.i < top.next.length) {
        const d = top.next[top.i++]!;
        if (d === top.key) this.selfLoops.add(d);
        if (!this.index.has(d)) frames.push(this.open(d));
        else if (this.onStack.has(d)) this.lower(top.key, this.index.get(d)!);
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) this.lower(parent.key, this.low.get(top.key)!);
      if (this.low.get(top.key) === this.index.get(top.key)) this.close(top.key);
    }
  }

  /** Evaluation order, and the formulas that sit in a cycle. */
  result(): { order: number[]; cyclic: Set<number> } {
    const order: number[] = [];
    const cyclic = new Set<number>();
    for (let i = this.components.length - 1; i >= 0; i--) {
      const component = this.components[i]!;
      const isCycle = component.length > 1 || this.selfLoops.has(component[0]!);
      for (const key of component) {
        order.push(key);
        if (isCycle) cyclic.add(key);
      }
    }
    return { order, cyclic };
  }

  private open(key: number): { key: number; next: number[]; i: number } {
    this.index.set(key, this.counter);
    this.low.set(key, this.counter);
    this.counter++;
    this.stack.push(key);
    this.onStack.add(key);
    return { key, next: this.dependents(key), i: 0 };
  }

  private lower(key: number, value: number): void {
    if (value < this.low.get(key)!) this.low.set(key, value);
  }

  /** `root` heads a component: pop it and everything above it off the stack. */
  private close(root: number): void {
    const component: number[] = [];
    let key: number;
    do {
      key = this.stack.pop()!;
      this.onStack.delete(key);
      component.push(key);
    } while (key !== root);
    this.components.push(component);
  }
}
