FROM node:22-alpine
WORKDIR /app
RUN npm install -g tsx
COPY seed.ts .
CMD ["tsx", "seed.ts"]
