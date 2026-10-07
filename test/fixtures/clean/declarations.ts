// Declaration-like snippets: signatures that reuse keywords and names the rules look for.
export interface Iterator<T> {
  next(value?: any): IteratorResult<T>;
  return?(value?: any): IteratorResult<T>;
  throw?(e?: any): IteratorResult<T>;
}

export interface FunctionSignature {
  return?: ReturnType | undefined;
  arguments?: readonly ArgumentType[] | undefined;
}

export declare class Generator<T> {
  return(value: any): IteratorResult<T>;
  throw(e: any): IteratorResult<T>;
}

declare function eval(x: string): any;

export class Repl {
  constructor(private readonly ctx: object) {}

  eval(code: string) {
    return runInContext(code, this.ctx);
  }

  protected tokenType: TrustTokenOperationType = 'Issuance';
}

export type TrustTokenOperationType = 'Issuance' | 'Redemption' | 'Signing';
export type PasswordKind = 'plain-text';

declare const apiKey: 'abcd1234efgh5678';

export const dynamicImport = new Function('module', 'return import(module)');

export function clear(el: HTMLElement): void {
  el.innerHTML = '';
  el.innerHTML = '<b>empty</b>';
}

export function agentOptions(secure: boolean, options: { rejectUnauthorized?: boolean }) {
  return { strictSsl: secure ? !!options.rejectUnauthorized : false };
}

declare function runInContext(code: string, ctx: object): unknown;
