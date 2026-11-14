export declare const FORBIDDEN_COPY: string[];
export declare const FORBIDDEN_IDENTIFIERS: { pattern: RegExp; invariant: string }[];
export declare const LINTED_EXTENSIONS: Set<string>;
export declare const IDENTIFIER_EXEMPT_PHRASES: string[];
export declare const NEVER_ALLOWED: string[];
export declare const STATUTORY_ALLOWED_IN: string[];
export declare const EMPLOYEE_TERM: string;
export declare function isStatutoryPath(relativePath: string): boolean;
export declare function findIdentifierHits(
  text: string,
): { index: number; match: string; invariant: string }[];
