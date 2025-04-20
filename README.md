# Pinterest Auto Poster

This is a Node.js script that automates posting pins to Pinterest using Puppeteer.

## Prerequisites

- Node.js (v14 or later recommended)
- npm

## Installation

1. Clone this repository or download the files
2. Install the dependencies:

```bash
npm install
```

3. Create a `.env` file in the root directory with your Pinterest credentials:

```
PIN_EMAIL=your-pinterest-email@example.com
PIN_PASSWORD=your-pinterest-password
```

## Usage

The script accepts a JSON payload via stdin. You can provide the payload in several ways:

### Using echo

```bash
echo '{"imageUrl": "https://example.com/image.jpg", "title": "My Pin Title", "description": "My pin description", "link": "https://example.com", "boardName": "My Board", "schedule": "now"}' | node index.js
```

### Using a JSON file

```bash
cat payload.json | node index.js
```

Where `payload.json` contains:

```json
{
  "imageUrl": "https://example.com/image.jpg",
  "title": "My Pin Title",
  "description": "My pin description",
  "link": "https://example.com",
  "boardName": "My Board",
  "schedule": "now"
}
```

## JSON Payload Structure

The JSON payload should include the following fields:

- `imageUrl` (required): The URL of the image to download and upload to Pinterest
- `title` (required): The title of the pin
- `description` (required): The description of the pin
- `link` (optional): The destination URL when the pin is clicked
- `boardName` (optional): The name of the Pinterest board to post to
- `schedule` (required): Specifies when to publish the pin. Use one of these formats:
  - `now`: Publish immediately
  - ISO format: `2025-04-20T22:30:00` for April 20, 2025 at 10:30 PM
  - AM/PM format: `2025-04-20 10:30 PM` for April 20, 2025 at 10:30 PM
  - Alternative format: `4/20/2025 10:30 PM` for April 20, 2025 at 10:30 PM

## Examples

### Post immediately

```json
{
  "imageUrl": "https://example.com/image.jpg",
  "title": "My Pin Title",
  "description": "My pin description",
  "link": "https://example.com",
  "boardName": "My Board",
  "schedule": "now"
}
```

### Schedule for later with AM/PM format

```json
{
  "imageUrl": "https://example.com/image.jpg",
  "title": "My Pin Title",
  "description": "My pin description",
  "link": "https://example.com",
  "boardName": "My Board",
  "schedule": "2025-04-20 10:30 PM"
}
```

## Features

- Automated Pinterest login with credentials from environment variables
- Cookie storage to avoid re-login on subsequent runs
- Image downloading from URL to temporary file
- Automated pin creation with title, description, link, and board selection
- Support for scheduling pins for future publication
- Error handling and timeouts
- Visual browser view (headless: false) for verification

## Notes

- The script runs with headless mode disabled (`headless: false`) so you can watch the automation happen and verify it works correctly.
- After the first successful login, the script will save cookies to avoid logging in again on subsequent runs.
- Temporary image files are automatically cleaned up after the script finishes. 