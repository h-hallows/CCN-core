/**
 * Pure domain logic. No database handle, no process.env, no Date.now() captured at
 * module scope — every function that needs the current date takes it as an argument.
 *
 * That is what makes the test suite deterministic, and it is what lets every surface
 * compute eligibility identically.
 */
export * from './credentials';
export * from './match';
export * from './businessDays';
export * from './dates';
export * from './care';
