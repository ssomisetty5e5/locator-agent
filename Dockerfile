# LocatorAgent in a container: Node, the compiled app and a matching Chromium.
#
#   docker build -t locator-agent .
#   docker run --rm -p 127.0.0.1:3000:3000 locator-agent
#
# then open http://localhost:3000
#
# The Playwright image ships the browsers; its tag must match the playwright
# version in package-lock.json.
ARG PLAYWRIGHT_VERSION=1.59.1

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=3000 \
    LA_HOST=0.0.0.0 \
    # Other private addresses stay blocked. The sample page served by this
    # container is the only local target; add yours with e.g.
    #   -e LA_ALLOWED_TARGETS=localhost:3000,host.docker.internal:4200
    LA_ALLOWED_TARGETS=localhost:3000,127.0.0.1:3000
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --chown=pwuser:pwuser package.json ./
COPY --chown=pwuser:pwuser public ./public
USER pwuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/api/server.js"]
