// Local entry point. On Vercel, api/index.js serves the same app.
const app = require('./app');

app.listen(app.PORT, () => {
  console.log(`Tiger Closet running at ${app.BASE_URL}`);
  if (app.DEV_LOGIN) console.log('DEV_LOGIN is on: you can log in with any NetID (disabled in production).');
});
