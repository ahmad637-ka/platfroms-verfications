# Microsoft ki official Playwright image use kar rahe hain -
# isme Chromium chalane ke liye zaroori saari system libraries
# (jaise libglib-2.0.so.0) pehle se installed hoti hain.
# NOTE: Ye version npm package.json mein diye Playwright version se
# EXACTLY match hona chahiye, warna "Executable doesn't exist" error aata hai.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

# Pehle sirf package.json copy karo (Docker caching ke liye better)
COPY package*.json ./
RUN npm install

# Baaki sara code copy karo
COPY . .

EXPOSE 8080

CMD ["node", "verification_server.js"]
