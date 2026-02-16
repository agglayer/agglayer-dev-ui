FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:stable-alpine

COPY --from=builder /app/out /usr/share/nginx/html
COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen       80;
    server_name  _;
    root         /usr/share/nginx/html;
    index        index.html;

    location / {
        try_files $uri $uri.html $uri/ /index.html;
    }

    location /config.json {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
}
EOF

VOLUME ["/usr/share/nginx/html/config.json"]

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
