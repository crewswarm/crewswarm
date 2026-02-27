FROM nginx:alpine

COPY . /usr/share/nginx/html

# Clean up non-web files
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/fly.toml \
          /usr/share/nginx/html/ROADMAP.md

# Gzip + cache headers
RUN printf 'server {\n\
    listen 8080 default_server;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    gzip on;\n\
    gzip_types text/plain text/css application/javascript image/svg+xml image/webp;\n\
    location ~* \\.md$ {\n\
        return 301 https://github.com/crewswarm/crewswarm;\n\
    }\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
        add_header Cache-Control "public, max-age=3600";\n\
    }\n\
    location ~* \\.(css|js)$ {\n\
        add_header Cache-Control "public, max-age=300, s-maxage=0";\n\
    }\n\
    location ~* \\.webp$ {\n\
        add_header Cache-Control "public, max-age=604800";\n\
        expires 7d;\n\
        add_header Content-Type image/webp;\n\
    }\n\
    location ~* \\.(png|jpg|jpeg|gif|ico|svg|woff2)$ {\n\
        add_header Cache-Control "public, max-age=604800";\n\
        expires 7d;\n\
    }\n\
    error_page 404 /404.html;\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 8080
