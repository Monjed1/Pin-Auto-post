# Pinterest Auto Post API

This API allows you to send Pinterest posts via HTTP POST requests from n8n or any other service.

## Server Setup on VPS

1. Ensure Node.js (v14+) and npm are installed on your VPS:
   ```bash
   curl -sL https://deb.nodesource.com/setup_16.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

2. Install dependencies:
   ```bash
   cd /var/www/Pin-Auto-post
   npm install
   ```

3. Set up the systemd service:
   ```bash
   sudo cp /var/www/Pin-Auto-post/pinterest-api.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable pinterest-api
   sudo systemctl start pinterest-api
   ```

4. Check the service status:
   ```bash
   sudo systemctl status pinterest-api
   ```

5. Configure firewall (if needed):
   ```bash
   sudo ufw allow 3000
   ```

## API Endpoints

### Health Check
- **URL**: `http://62.171.168.74:3000/health`
- **Method**: GET
- **Response**: `{"status":"healthy","message":"Pinterest API server is running"}`

### Post to Pinterest
- **URL**: `http://62.171.168.74:3000/api/pinterest/post`
- **Method**: POST
- **Content-Type**: application/json
- **Required Fields**:
  - `imageUrl`: Direct URL to the image to be posted
  - `title`: Title for the Pinterest pin
- **Optional Fields**:
  - `description`: Additional text for the pin
  - `link`: URL to link from the pin
  - `boardName`: Name of the Pinterest board (default board used if not specified)
  - `schedule`: When to publish the pin ("now" or a date like "2025-04-20 11:30 PM")
  - `tags`: Array or string of tags in format "(tag1, tag2, tag3)"

## Example Request for n8n

In your n8n HTTP Request node:

1. Set Method to POST
2. URL: `http://62.171.168.74:3000/api/pinterest/post`
3. Headers: `Content-Type: application/json`
4. JSON Body:
```json
{
  "imageUrl": "https://example.com/image.jpg",
  "title": "Your Pinterest Pin Title",
  "description": "Detailed description for your pin",
  "link": "https://yourdestinationlink.com",
  "boardName": "Your Board Name",
  "schedule": "now",
  "tags": "(tag1, tag2, lifestyle)"
}
```

## Troubleshooting

- Check logs: `sudo journalctl -u pinterest-api`
- Restart service: `sudo systemctl restart pinterest-api`
- Ensure the VPS IP is accessible and the port is open
- Verify the payload format matches the expected structure 