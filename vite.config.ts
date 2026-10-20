import { defineConfig } from "vite";

const SERVER = `http://localhost:${process.env.MESA_PORT ?? 30100}`;

export default defineConfig({
  root: "client",
  // Built JS/CSS go under /static so they never collide with world files served at /assets.
  build: { outDir: "../dist/client", emptyOutDir: true, assetsDir: "static" },
  server: {
    port: 5173,
    proxy: {
      "/api": SERVER,
      "/assets": SERVER,
      "/socket.io": { target: SERVER, ws: true }
    }
  }
});
