/**
 * Imported FIRST by HTTP-level tests. dotenv never overrides a variable that
 * is already set, so this keeps the real JWT secret and credentials key in
 * BE/.env out of the test process: tokens here are signed with a throwaway
 * secret and can only ever open this in-process app.
 */
process.env.JWT_SECRET = 'http-test-secret-not-used-anywhere-else';
process.env.BROKER = 'paper';
process.env.DATA_SOURCE = process.env.DATA_SOURCE ?? 'yahoo';
