// Local entry point. On Vercel, api/index.js serves the same app.
const app = require('./app');

app.listen(app.PORT, () => {
  console.log(`Tiger Closet running at ${app.BASE_URL}`);
});
