# Build Step 1 - Create the base
FROM node:24.14-alpine AS base
RUN apk add git --no-cache
COPY ./ /usr/src/app
WORKDIR /usr/src/app
RUN npm install
RUN npm install --platform=linuxmusl --arch=x64 sharp
RUN npm run download-music
RUN cd edit/assetpack && npm install --platform=linuxmusl --arch=x64 sharp
RUN npm run assetpack

# Build Step 2 - Build the application
FROM base AS builder
WORKDIR /usr/src/app
RUN npm run build

# Build Step 3 - Build a minimal production-ready image
#
# --ignore-scripts is used in the `npm install` to ignore the postinstall-script
# because in the production-ready image we do not need the sources for
# the assetpack or music assets in the isolated image for running the app.

FROM node:24.14-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production --ignore-scripts
COPY --from=builder /usr/src/app/app/public/dist ./app/public/dist
EXPOSE 9000
ENTRYPOINT ["node", "--experimental-require-module", "app/public/dist/server/app/index.js"]