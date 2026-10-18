FROM mcr.microsoft.com/playwright:v1.48.2-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npx playwright install chromium
COPY . .
ENV NODE_ENV=production
EXPOSE 10000
CMD ["npm", "start"]
