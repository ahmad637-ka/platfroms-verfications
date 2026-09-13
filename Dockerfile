# Microsoft ki official Playwright image use kar rahe hain -
# isme Chromium chalane ke liye zaroori saari system libraries
# (jaise libglib-2.0.so.0) pehle se installed hoti hain.
FROM mcr.microsoft.com/playwright:v1.44.1-jammy

WORKDIR /app

# Pehle sirf package.json copy karo (Docker caching ke liye better)
COPY package*.json ./
RUN npm install

# Baaki sara code copy karo
COPY . .

EXPOSE 8080

CMD ["node", "verification_server.js"]
