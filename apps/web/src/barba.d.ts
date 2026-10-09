declare module "@barba/core" {
  type Page = { container: HTMLElement; url: { href: string } };
  type TransitionData = { current: Page; next: Page };
  type Hook = (data: TransitionData) => void | Promise<void>;
  const barba: {
    init(options: {
      preventRunning?: boolean;
      prevent?: (data: { el: HTMLElement }) => boolean;
      transitions: { name: string; once?: Hook; leave?: Hook; enter?: Hook }[];
    }): void;
    go(url: string): Promise<void>;
    destroy(): void;
  };
  export default barba;
}
