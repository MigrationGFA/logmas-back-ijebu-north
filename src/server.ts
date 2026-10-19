import env from './config/env';
import app from './app';

const PORT = env.PORT || 3006;

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not defined in environment variables');
}
if (!process.env.JWT_REFRESH_SECRET) {
  console.warn('JWT_REFRESH_SECRET not set – using JWT_SECRET as fallback (not recommended)');
  process.env.JWT_REFRESH_SECRET = process.env.JWT_SECRET;
}

app.listen(PORT, () => {
  console.log(`🚀 LOGMAS API Engine running on mode: [${env.NODE_ENV}] listening intently on tracking socket port reference: ${PORT}`);
  console.log(`📑 Swagger Documentation active dashboard endpoints maps served directly on: http://localhost:${PORT}/api/v1/docs`);
  console.log("✅✅ endpoint active")
});