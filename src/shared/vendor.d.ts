declare module "@citation-js/core" {
  export const plugins: any;
  export class Cite {
    constructor(input: unknown, options?: unknown);
    data: any[];
    format(format: string, options?: unknown): any;
  }
}
declare module "@citation-js/plugin-bibtex";
