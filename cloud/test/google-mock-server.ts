// Standalone local stand-in for Google, for the real-browser end-to-end run only (NOT Google, NOT part of the product).
//   PORT=8790 npx tsx test/google-mock-server.ts      then point GOOGLE_TOKEN_URL=http://127.0.0.1:8790/token and GOOGLE_JWKS_URL=http://127.0.0.1:8790/certs at it.
import { startGoogleMock } from './google-mock';
const port = Number(process.env['PORT'] ?? 8790);
startGoogleMock(process.env['MOCK_CLIENT_ID'] ?? 'mock-web-client.apps.googleusercontent.com', process.env['MOCK_CLIENT_SECRET'] ?? 'mock-secret-not-real', port).then((m) => { console.log(`google mock listening on ${m.url} `); });
