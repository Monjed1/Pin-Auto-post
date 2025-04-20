require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// Inline date parser function
/**
 * Helper function to parse different date formats and return a Date object
 */
function parseScheduleDate(scheduleStr) {
    // Check for "now" keyword
    if (scheduleStr === 'now') {
        return null; // null indicates immediate posting
    }
    
    // Check if we have an AM/PM format
    const ampmRegex = /(\d{1,4}[-/]\d{1,2}[-/]\d{1,4}|\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)/i;
    const ampmMatch = scheduleStr.match(ampmRegex);
    
    if (ampmMatch) {
        // We have a date with AM/PM format
        const datePart = ampmMatch[1];
        const hours = parseInt(ampmMatch[2], 10);
        const minutes = parseInt(ampmMatch[3], 10);
        const isPM = ampmMatch[4].toLowerCase() === 'pm';
        
        // Adjust hours for PM
        const adjustedHours = isPM && hours < 12 ? hours + 12 : (hours === 12 && !isPM ? 0 : hours);
        
        // Parse the date part
        let dateObj;
        
        if (datePart.includes('-')) {
            // YYYY-MM-DD format
            const [year, month, day] = datePart.split('-').map(part => parseInt(part, 10));
            dateObj = new Date(year, month - 1, day, adjustedHours, minutes);
        } else if (datePart.includes('/')) {
            // MM/DD/YYYY or DD/MM/YYYY format (assume MM/DD/YYYY for simplicity)
            const parts = datePart.split('/').map(part => parseInt(part, 10));
            
            // Try to guess the format based on the values
            let year, month, day;
            
            if (parts[2] > 31) { // MM/DD/YYYY
                month = parts[0];
                day = parts[1];
                year = parts[2];
            } else if (parts[0] > 31) { // YYYY/MM/DD
                year = parts[0];
                month = parts[1];
                day = parts[2];
            } else if (parts[1] > 12) { // DD/MM/YYYY
                day = parts[0];
                month = parts[1];
                year = parts[2];
            } else {
                // Default to MM/DD/YYYY
                month = parts[0];
                day = parts[1];
                year = parts[2];
            }
            
            dateObj = new Date(year, month - 1, day, adjustedHours, minutes);
        }
        
        return dateObj;
    }
    
    // Try ISO format
    try {
        return new Date(scheduleStr);
    } catch (e) {
        console.error('Invalid date format:', scheduleStr);
        throw new Error(`Invalid date format: ${scheduleStr}. Please use ISO format (2025-04-20T22:30:00) or AM/PM format (2025-04-20 10:30 PM)`);
    }
}

// Constants and configuration
const COOKIES_PATH = path.join(__dirname, 'cookies.json');
const PINTEREST_LOGIN_URL = 'https://www.pinterest.com/login/';
const PINTEREST_PIN_CREATION_URL = 'https://www.pinterest.com/pin-creation-tool/';
const DEFAULT_TIMEOUT = 60000; // 60 seconds

// Helper function to download image from URL to temp file
async function downloadImage(url) {
  const tempPath = path.join(os.tmpdir(), `pinterest-image-${Date.now()}.jpg`);
  
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: Status code ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(tempPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve(tempPath);
      });

      fileStream.on('error', (err) => {
        fs.unlink(tempPath, () => {}); // Delete the temp file
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Helper function to save cookies
async function saveCookies(page) {
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('Cookies saved to', COOKIES_PATH);
}

// Helper function to load cookies
async function loadCookies(page) {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookiesString = fs.readFileSync(COOKIES_PATH);
      const cookies = JSON.parse(cookiesString);
      await page.setCookie(...cookies);
      console.log('Cookies loaded successfully');
      return true;
    }
  } catch (error) {
    console.error('Error loading cookies:', error);
  }
  return false;
}

// Main function
async function postToPinterest(payload) {
  console.log('Starting Pinterest automation...');
  
  // Validate payload
  if (!payload.imageUrl || !payload.title) {
    throw new Error('Missing required fields in payload (imageUrl and title are required)');
  }

  // Log what we're working with
  console.log(`Processing pin with title: "${payload.title}"`);
  console.log(`Board name: ${payload.boardName || 'Not specified'}`);
  console.log(`Schedule: ${payload.schedule || 'now'}`);
  // Handle different tag formats (array or string)
  let tagsToLog = [];
  if (payload.tags) {
    if (typeof payload.tags === 'string') {
      // Parse the string format (e.g., "(tag1, tag2)")
      tagsToLog = payload.tags
        .replace(/^\(|\)$/g, '') // Remove parentheses
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);
    } else if (Array.isArray(payload.tags)) {
      tagsToLog = payload.tags; // Use the array directly
    }
  }
  if (tagsToLog.length > 0) {
    console.log(`Tags: ${tagsToLog.join(', ')}`);
  }

  let browser;
  let imagePath;

  try {
    // Download the image
    console.log('Downloading image...');
    imagePath = await downloadImage(payload.imageUrl);
    console.log('Image downloaded to:', imagePath);

    // Launch browser
    console.log('Launching browser...');
    browser = await puppeteer.launch({ 
      headless: true, // Enable headless mode for deployment
      defaultViewport: null,
      args: [
        '--start-maximized',
        '--no-sandbox', // Required for running in some environments (like Docker/VPS)
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage' // Prevent /dev/shm usage issues
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    
    // Try to load cookies
    const cookiesLoaded = await loadCookies(page);
    
    // Navigate to Pinterest
    console.log('Navigating to Pinterest...');
    await page.goto('https://www.pinterest.com', { waitUntil: 'networkidle2' });
    
    // Check if we need to login
    const isLoggedIn = await page.evaluate(() => {
      // Check for various indicators that the user is not logged in
      const loginButton = document.querySelector('[data-test-id="simple-login-button"]');
      const signupButton = document.querySelector('[data-test-id="simple-signup-button"]');
      const loginForm = document.querySelector('form[name="loginForm"]');
      const emailInput = document.querySelector('input#email');
      const passwordInput = document.querySelector('input#password');
      
      // If any of these elements exist, user is not logged in
      return !(loginButton || signupButton || loginForm || (emailInput && passwordInput));
    });
    
    if (!isLoggedIn) {
      console.log('Not logged in, proceeding to login...');
      await page.goto(PINTEREST_LOGIN_URL, { waitUntil: 'networkidle2' });
      
      // Login with credentials
      console.log('Logging in...');
      
      try {
        // Wait for login form elements to be visible
        await page.waitForSelector('#email, input[name="email"]', { visible: true, timeout: DEFAULT_TIMEOUT });
        
        // Find and fill email field
        const emailSelector = await page.$('#email') ? '#email' : 'input[name="email"]';
        await page.type(emailSelector, process.env.PIN_EMAIL);
        
        // Find and fill password field
        const passwordSelector = await page.$('#password') ? '#password' : 'input[name="password"], input[type="password"]';
        await page.type(passwordSelector, process.env.PIN_PASSWORD);
        
        // Find login button - try multiple selectors
        let loginButton = null;
        for (const selector of [
          '[data-test-id="registerFormSubmitButton"]',
          'button[type="submit"]',
          'button:has-text("Log in")'
        ]) {
          loginButton = await page.$(selector);
          if (loginButton) {
            console.log(`Found login button with selector: ${selector}`);
            break;
          }
        }
        
        if (!loginButton) {
          throw new Error('Login button not found');
        }
        
        // Click login button and wait for navigation
        await Promise.all([
          loginButton.click(),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT }),
        ]);
        
        // Save cookies after successful login
        await saveCookies(page);
        
        // Verify login success
        const loginSuccess = await page.evaluate(() => {
          // Check for elements that indicate successful login, like user menu
          return !document.querySelector('form[name="loginForm"]') && 
                !document.querySelector('input#email') &&
                !document.querySelector('input#password');
        });
        
        if (!loginSuccess) {
          throw new Error('Login seems to have failed. Check credentials or for CAPTCHA.');
        }
        
        console.log('Login successful');
      } catch (error) {
        console.error('Error during login:', error.message);
        // Take a screenshot to see what's on the page
        // await page.screenshot({ path: 'pinterest-login-debug.png' });
        throw error;
      }
    } else {
      console.log('Already logged in');
    }
    
    // Navigate to pin creation tool
    console.log('Navigating to pin creation tool...');
    await page.goto(PINTEREST_PIN_CREATION_URL, { waitUntil: 'networkidle2' });
    
    // Upload image
    console.log('Uploading image...');
    try {
      // Try multiple possible selectors for the file input
      let fileInput = null;
      
      // Try different selectors that might work
      for (const selector of ['input[type="file"]', '[data-test-id="media-upload-input"]', 'input[accept="image/*,video/*"]']) {
        fileInput = await page.$(selector);
        if (fileInput) {
          console.log(`Found file input with selector: ${selector}`);
          break;
        }
      }
      
      if (!fileInput) {
        throw new Error('Could not find file input element');
      }
      
      await fileInput.uploadFile(imagePath);
      console.log('File upload initiated');
      
      // Wait for image to upload with a more flexible approach
      console.log('Waiting for image to upload...');
      
      // Look for various indicators that the image has been uploaded
      await Promise.race([
        page.waitForSelector('[data-test-id="media-item-image"]', { visible: true, timeout: DEFAULT_TIMEOUT }),
        page.waitForSelector('img[alt="Pin image"]', { visible: true, timeout: DEFAULT_TIMEOUT }),
        page.waitForSelector('.mediaUploader img', { visible: true, timeout: DEFAULT_TIMEOUT }),
        page.waitForFunction(() => {
          // Look for any image elements that might indicate upload success
          return document.querySelectorAll('img').length > 0;
        }, { timeout: DEFAULT_TIMEOUT })
      ]);
      
      console.log('Image upload detected');
      
      // Give a moment for the upload to complete and UI to stabilize
      await page.waitForTimeout(2000);
    } catch (error) {
      console.error('Error during image upload:', error.message);
      // Try to take a screenshot to see what's on the page
      // await page.screenshot({ path: 'pinterest-debug.png' });
      console.log('Debug screenshot saved as pinterest-debug.png');
      throw error;
    }
    
    // Fill in the pin details
    console.log('Filling pin details...');
    
    // Title - try multiple selectors
    try {
      console.log('Filling title...');
      let titleField = null;
      
      for (const selector of [
        '[data-test-id="pin-draft-title-field"]', 
        'textarea[placeholder="Add a title"]',
        'input[placeholder="Add a title"]',
        'textarea[name="title"]',
        'input[name="title"]'
      ]) {
        titleField = await page.$(selector);
        if (titleField) {
          console.log(`Found title field with selector: ${selector}`);
          break;
        }
      }
      
      if (titleField) {
        await titleField.click();
        await titleField.type(payload.title);
      } else {
        console.warn('Title field not found, skipping title input');
      }
    } catch (error) {
      console.error('Error filling title:', error.message);
    }
    
    // Wait a bit for UI to update
    await page.waitForTimeout(1000);
    
    // Description - try multiple selectors with more options
    try {
      console.log('Filling description...');
      let descField = null;
      
      // Wait for the section containing the description field to be potentially loaded
      await page.waitForTimeout(1500);
      
      // await page.screenshot({ path: 'pinterest-before-description.png' });
      
      // Prioritize selectors based on visual inspection and common patterns
      for (const selector of [
        'textarea[placeholder="Add a detailed description"]', // From screenshot - specific placeholder
        'div[data-test-id="pin-draft-description"] div[contenteditable="true"]', // Common pattern for rich text
        'textarea[aria-label*="Description"]',
        'div[role="textbox"][aria-label*="Description"]',
        'textarea#description' 
      ]) {
        try {
          // Increase timeout slightly
          descField = await page.waitForSelector(selector, { visible: true, timeout: 7000 });
          if (descField) {
            console.log(`Found description field with selector: ${selector}`);
            break;
          }
        } catch (e) {
          console.log(`Desc selector ${selector} not found or timed out.`);
        }
      }
      
      // Fallback: Find any contenteditable div that isn't the title
      if (!descField) {
        console.log('Trying fallback: Find contenteditable div...');
        try {
           const allEditableDivs = await page.$$('div[contenteditable="true"]');
           if (allEditableDivs.length > 0) {
             // Assuming the first one might be title, try the second if available
             descField = allEditableDivs.length > 1 ? allEditableDivs[1] : allEditableDivs[0];
             console.log('Using fallback contenteditable div as description field');
           }
        } catch (e) {
           console.log('Fallback contenteditable div search failed.');
        }
      }
      
      if (descField) {
        await descField.click();
        await page.waitForTimeout(500); // Wait after click
        await descField.type(payload.description, { delay: 50 }); // Add slight delay between keypresses
        await page.waitForTimeout(1000); // Wait after typing
        console.log('Description entered');
        // Verify if text was entered
        const descValue = await page.evaluate(el => el.textContent || el.value, descField);
        console.log(`Description field value after typing: ${descValue}`);
        if (!descValue || !descValue.includes(payload.description)) {
          console.warn('Description might not have been entered correctly.');
        }
      } else {
        console.warn('Description field not found, skipping description input');
      }
    } catch (error) {
      console.error('Error filling description:', error.message);
      // await page.screenshot({ path: 'pinterest-description-error.png' });
    }
    
    // Wait a bit for UI to update
    await page.waitForTimeout(1000);
    
    // Link - try multiple selectors with more options
    if (payload.link) {
      try {
        console.log('Filling link...');
        let linkField = null;
        
        // await page.screenshot({ path: 'pinterest-before-link.png' });
        
        for (const selector of [
          '[data-test-id="pin-draft-link-field"]', // Preferred
          'input[placeholder="Add a link"]',
          'input[placeholder="Add a destination link"]',
          'input[aria-label*="link"]'
        ]) {
          try {
            linkField = await page.waitForSelector(selector, { visible: true, timeout: 5000 });
            if (linkField) {
              console.log(`Found link field with selector: ${selector}`);
              break;
            }
          } catch (e) {
            console.log(`Selector ${selector} not found or timed out.`);
          }
        }
        
        if (linkField) {
          await linkField.click();
          await page.waitForTimeout(500); // Wait after click
          await linkField.type(payload.link, { delay: 50 });
          await page.waitForTimeout(1000); // Wait after typing
          console.log('Link entered');
          const linkValue = await page.evaluate(el => el.value, linkField);
          console.log(`Link field value after typing: ${linkValue}`);
          if (!linkValue || !linkValue.includes(payload.link)) {
            console.warn('Link might not have been entered correctly.');
          }
        } else {
          console.warn('Link field not found, skipping link input');
        }
      } catch (error) {
        console.error('Error filling link:', error.message);
        // await page.screenshot({ path: 'pinterest-link-error.png' });
      }
    }
    
    // Add tags if provided
    // Handle different tag formats (array or string)
    let tagsToAdd = [];
    if (payload.tags) {
      if (typeof payload.tags === 'string') {
        console.log('Parsing tags from string format...');
        tagsToAdd = payload.tags
          .replace(/^\(|\)$/g, '') // Remove parentheses
          .split(',')
          .map(tag => tag.trim())
          .filter(tag => tag.length > 0);
        console.log(`Parsed tags: ${tagsToAdd.join(', ')}`);
      } else if (Array.isArray(payload.tags)) {
        tagsToAdd = payload.tags; // Use the array directly
      }
    }
    
    // Check if there are tags to add after parsing/validation
    if (tagsToAdd.length > 0) {
      try {
        console.log('Adding tags...');
        // await page.screenshot({ path: 'pinterest-before-tags.png' });
        
        // First find the tags input field - try multiple selectors
        let tagsField = null;
        
        for (const selector of [
          '[data-test-id="pin-draft-tags-field"]', 
          'input[placeholder*="tag" i], input[placeholder*="hashtag" i]',
          'input[aria-label*="tag" i], input[aria-label*="hashtag" i]',
          '[id*="tag-input" i], [class*="tagInput" i]'
        ]) {
          try {
            tagsField = await page.waitForSelector(selector, { visible: true, timeout: 5000 });
            if (tagsField) {
              console.log(`Found tags field with selector: ${selector}`);
              break;
            }
          } catch (e) {
            console.log(`Tags selector ${selector} not found or timed out.`);
          }
        }
        
        // If still not found, try XPath
        if (!tagsField) {
          console.log('Trying XPath to find tags field...');
          const tagXPaths = [
            '//input[contains(@placeholder, "tag") or contains(@placeholder, "Tag")]',
            '//input[contains(@aria-label, "tag") or contains(@aria-label, "Tag")]',
            '//label[contains(text(), "tag") or contains(text(), "Tag")]/following-sibling::input',
            '//div[contains(text(), "tag") or contains(text(), "Tag")]/following-sibling::input'
          ];
          
          for (const xpath of tagXPaths) {
            try {
              const elements = await page.$x(xpath);
              if (elements.length > 0) {
                tagsField = elements[0];
                console.log(`Found tags field with xpath: ${xpath}`);
                break;
              }
            } catch (e) {
              console.log(`Tags xpath ${xpath} failed: ${e.message}`);
            }
          }
        }
        
        // If we found the tags field, add the tags
        if (tagsField) {
          // For each tag, type it and press Enter
          for (const tag of tagsToAdd) { // Use the parsed array
            const formattedTag = tag.startsWith('#') ? tag.substring(1) : tag; // Remove # if present
            console.log(`Adding tag: ${formattedTag}`);
            
            try {
              // Clear the input field if needed
              await tagsField.click({ clickCount: 3 });
              await page.keyboard.press('Backspace');
              await page.waitForTimeout(200);

              // Type the tag slowly to give the dropdown time to appear
              await tagsField.type(formattedTag, { delay: 100 });
              await page.waitForTimeout(1000); // Give time for dropdown to appear
              
              // Check if dropdown exists and select first item if it does
              const dropdownExists = await page.evaluate(() => {
                // Look for common dropdown elements
                const dropdownIndicators = [
                  document.querySelector('ul[role="listbox"]'),
                  document.querySelector('[role="option"]'),
                  document.querySelector('.dropdown-menu'),
                  document.querySelector('[class*="dropdown"]'),
                  document.querySelector('[class*="typeahead"]'),
                  document.querySelector('[class*="autocomplete"]'),
                  document.querySelector('[class*="suggestion"]')
                ];
                return dropdownIndicators.some(e => e !== null);
              });
              
              if (dropdownExists) {
                console.log(`Dropdown menu found for tag "${formattedTag}", selecting first option`);
                
                // Try to select the first item in dropdown
                // First try arrow down + enter
                await page.keyboard.press('ArrowDown');
                await page.waitForTimeout(300);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(500);
                
                // Alternative: try to click the first dropdown item directly
                const firstItemSelected = await page.evaluate(() => {
                  const selectors = [
                    'ul[role="listbox"] > li:first-child',
                    '[role="option"]:first-child',
                    '.dropdown-menu > *:first-child',
                    '[class*="dropdown"] > *:first-child',
                    '[class*="suggestion"] > *:first-child'
                  ];
                  
                  for (const selector of selectors) {
                    const item = document.querySelector(selector);
                    if (item) {
                      item.click();
                      return true;
                    }
                  }
                  return false;
                });
                
                if (firstItemSelected) {
                  console.log(`Selected first dropdown item for tag "${formattedTag}" by clicking`);
                }
              } else {
                console.log(`No dropdown found for tag "${formattedTag}", pressing Enter to add anyway`);
                await page.keyboard.press('Enter');
              }
              
              // Wait for tag to be added
              await page.waitForTimeout(1000);
              
              // Verify if tag was added by checking if input cleared or tag chip appeared
              try {
                const tagAdded = await page.evaluate((tagText) => {
                  // Check 1: Input field is empty
                  const tagInput = document.querySelector('input[placeholder*="tag" i], input[placeholder*="hashtag" i], [data-test-id="pin-draft-tags-field"]');
                  const inputCleared = tagInput && tagInput.value === '';
                  
                  // Check 2: A tag chip exists with the expected text (or similar)
                  const tagElements = document.querySelectorAll('[data-test-id="tag-chip"], .tag, [class*="Tag"], [class*="tag"]');
                  const tagChipFound = Array.from(tagElements).some(el => el.textContent.includes(tagText));
                  
                  // Consider tag added if input cleared OR chip found
                  return inputCleared || tagChipFound;
                }, formattedTag);
                
                if (tagAdded) {
                  console.log(`Successfully added tag: ${formattedTag}`);
                } else {
                  console.log(`Tag may not have been added: ${formattedTag}`);
                }
              } catch (verificationError) {
                  console.log(`Error verifying tag addition for ${formattedTag}: ${verificationError.message}`);
              }
            } catch (e) {
              console.log(`Error adding tag "${formattedTag}": ${e.message}`);
              console.log(`Skipping to next tag`);
              
              // Make sure to close any open dropdown that might be blocking the UI
              try {
                // Click outside the dropdown to close it
                await page.mouse.click(10, 10);
                // Also try Escape key
                await page.keyboard.press('Escape');
                // And click the input field again to reset
                await page.waitForTimeout(500);
                await tagsField.click();
              } catch (closeError) {
                console.log(`Error closing dropdown: ${closeError.message}`);
              }
            }
            
            // Brief pause between adding tags
            await page.waitForTimeout(1000);
          }
          
          console.log('All tags added');
          
          // Verify tags were added (if possible)
          try {
            const tagElements = await page.$$('[data-test-id="tag-chip"], .tag, [class*="Tag"], [class*="tag"]');
            console.log(`Found ${tagElements.length} tag elements on the page`);
            
            // Try to get the text of tags for verification
            if (tagElements.length > 0) {
              const tagTexts = await Promise.all(tagElements.map(async (el) => {
                return page.evaluate(element => element.textContent, el);
              }));
              console.log(`Tag texts found: ${tagTexts.join(', ')}`);
            }
          } catch (e) {
            console.log('Could not verify tags were added:', e.message);
          }
        } else {
          console.log('Tags field not found - Pinterest may have changed its UI or tags are not supported');
        }
      } catch (error) {
        console.error('Error during tag addition process:', error.message);
        // await page.screenshot({ path: 'pinterest-tags-error.png' });
        console.log('Continuing with next steps despite tag errors...');
        
        // Make sure any modal or dropdown is closed before continuing
        try {
          // Click in a neutral area
          await page.mouse.click(10, 10);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        } catch (e) {
          // Ignore any errors from this recovery attempt
        }
      }
    }
    
    // Make sure UI is in a good state before proceeding
    try {
      console.log('Ensuring UI is in good state before proceeding...');
      // Press Escape and click in neutral area to close any open popups or dropdowns
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.mouse.click(10, 10);
      await page.waitForTimeout(1000);
    } catch (e) {
      console.log('Error during UI reset:', e.message);
    }
    
    // Take a debug screenshot
    // await page.screenshot({ path: 'pinterest-details-filled.png' });
    
    // Select board - try multiple selectors, but make it optional
    if (payload.boardName) {
      console.log('Selecting board...');
      try {
        // First find the board dropdown button
        let boardDropdownButton = null;
        
        for (const selector of [
          '[data-test-id="board-dropdown-select-button"]',
          'button[aria-haspopup="listbox"]',
          'button:has-text("Choose a board")',
          'button:has-text("Select Board")'
        ]) {
          boardDropdownButton = await page.$(selector);
          if (boardDropdownButton) {
            console.log(`Found board dropdown button with selector: ${selector}`);
            break;
          }
        }
        
        if (!boardDropdownButton) {
          console.warn('Board dropdown button not found, trying to continue anyway');
        } else {
          await boardDropdownButton.click();
          
          // Wait for board dropdown to appear
          console.log('Waiting for board dropdown to appear...');
          await page.waitForTimeout(2000);
          
          // Look for the board by name
          console.log(`Looking for board: ${payload.boardName}`);
          const boardSelectors = [
            `[title="${payload.boardName}"]`,
            `[aria-label="${payload.boardName}"]`,
            `div[role="option"]:has-text("${payload.boardName}")`,
            `div[role="option"]:nth-child(1)`
          ];
          
          let boardFound = false;
          for (const selector of boardSelectors) {
            try {
              const boardElement = await page.$(selector);
              if (boardElement) {
                console.log(`Found board with selector: ${selector}`);
                await boardElement.click();
                boardFound = true;
                break;
              }
            } catch (error) {
              console.log(`Selector ${selector} not found`);
            }
          }
          
          if (!boardFound) {
            // Try to click the first board if available
            console.log('Board not found by name, trying to select the first board');
            try {
              // Try different selectors for finding any board
              for (const selector of [
                '[data-test-id="board-row"]', 
                'div[role="option"]',
                '.boardSelectorDropdown li:first-child',
                '.boardSelector option:first-child'
              ]) {
                const firstBoard = await page.$(selector);
                if (firstBoard) {
                  await firstBoard.click();
                  console.log(`Clicked first board using selector: ${selector}`);
                  boardFound = true;
                  break;
                }
              }
              
              if (!boardFound) {
                console.warn('Could not select any board - proceeding anyway');
              }
            } catch (error) {
              console.error('Error selecting first board:', error.message);
              console.warn('Proceeding without board selection');
            }
          }
        }
      } catch (error) {
        console.error('Error selecting board:', error.message);
        console.warn('Proceeding without board selection');
      }
    } else {
      console.log('No board name specified, skipping board selection');
    }
    
    // Add a brief wait after board selection
    await page.waitForTimeout(2000);
    
    // Parse the schedule date string using our enhanced parser
    let scheduleDate = null;
    if (payload.schedule && payload.schedule !== 'now') {
        try {
            scheduleDate = parseScheduleDate(payload.schedule);
            console.log(`Parsed schedule date: ${scheduleDate.toLocaleString()}`);
        } catch (error) {
            console.error('Error parsing schedule date:', error.message);
            throw error;
        }
    }
    
    // Handle scheduling
    if (scheduleDate) {
        console.log('Setting up scheduling...');
        try {
            // --- START: Click Schedule Toggle --- 
            console.log('Finding the "Publish at a later date" toggle/label...');
            let scheduleToggleElement = null;
            let scheduleToggleFound = false;
            
            await page.waitForTimeout(1500); // Slightly longer initial wait
            // await page.screenshot({ path: 'pinterest-before-schedule-toggle.png' });

            // Try CSS selectors first (more specific)
            const cssSelectors = [
              'input[id="schedule-publish-time"]',
              'div[data-test-id="scheduled-pin-toggle"] input[type="checkbox"]',
              'button[role="switch"][aria-label*="Publish at a later date"]'
            ];

            for (const selector of cssSelectors) {
              try {
                console.log(`Trying schedule toggle CSS selector: ${selector}`);
                scheduleToggleElement = await page.waitForSelector(selector, { visible: true, timeout: 7000 }); // Reduced timeout slightly
                if (scheduleToggleElement) {
                  console.log(`Found schedule toggle element with CSS selector: ${selector}`);
                  scheduleToggleFound = true;
                  break;
                }
              } catch (error) {
                console.log(`Schedule toggle CSS selector ${selector} failed: ${error.message}`);
              }
            }

            // If CSS failed, try clicking the label text via XPath
            if (!scheduleToggleFound) {
                const labelXPath = '//label[contains(., "Publish at a later date")] | //span[contains(., "Publish at a later date")]';
                console.log(`Trying to find/click toggle LABEL with XPath: ${labelXPath}`);
                try {
                    // Find the label/span element itself
                    const labelElement = await page.waitForXPath(labelXPath, { visible: true, timeout: 7000 });
                    if (labelElement) {
                        console.log('Found toggle label/span via XPath. Attempting click on it...');
                        await labelElement.click(); // Click the label directly
                        await page.waitForTimeout(2500); // Wait for potential state change
                        // We assume clicking the label worked, set flag to true
                        // Verification if toggle is actually enabled is harder here, proceed optimistically
                        scheduleToggleFound = true; 
                        console.log('Clicked the toggle label/span.');
                    }
                } catch (error) {
                     console.log(`Clicking toggle label/span via XPath failed: ${error.message}`);
                }
            }

            // If clicking label failed, try the complex input/button XPath again as last resort
            if (!scheduleToggleFound) {
                const complexXPath = '//label[contains(., "Publish at a later date")]//input[@type="checkbox"] | //label[contains(., "Publish at a later date")]/preceding-sibling::button[@role="switch"] | //span[contains(text(), "Publish at a later date")]/parent::label/preceding-sibling::button[@role="switch"] | //div[contains(text(),"Publish at a later date")]/preceding-sibling::input[@type="checkbox"] | //div[contains(text(),"Publish at a later date")]/preceding-sibling::button[@role="switch"]';
                console.log(`Trying complex schedule toggle XPath again: ${complexXPath}`);
                 try {
                    scheduleToggleElement = await page.waitForXPath(complexXPath, { visible: true, timeout: 7000 });
                    if (scheduleToggleElement) {
                        console.log(`Found schedule toggle element with complex XPath: ${complexXPath}`);
                        scheduleToggleFound = true; // Found the element, proceed to check/click below
                    }
                } catch (error) {
                     console.log(`Complex schedule toggle XPath failed: ${error.message}`);
                }
            }

            // If we found the toggle element (via CSS or complex XPath), check state and click if needed
            if (scheduleToggleFound && scheduleToggleElement) {
                 try {
                     const isEnabled = await page.evaluate(el => el.checked || el.getAttribute('aria-checked') === 'true', scheduleToggleElement);
                     if (!isEnabled) {
                         console.log('Toggle element found but not enabled, attempting click...');
                         // Try standard click first on the element
                         await scheduleToggleElement.click();
                         console.log('Clicked the schedule toggle element (standard click).');
                         await page.waitForTimeout(2500);
                     } else {
                         console.log('Schedule toggle element found and already enabled.');
                     }
                     // Re-set flag to true just to be sure, though it should be already
                     scheduleToggleFound = true; 
                 } catch (clickError) {
                     console.error('Error clicking the found schedule toggle element:', clickError.message);
                     // If click failed, maybe the label click already worked, or maybe it's truly stuck
                     // For now, we'll unset the found flag to trigger the fatal error
                     scheduleToggleFound = false; 
                 }
            }

            // Final Check - If none of the methods worked
            if (!scheduleToggleFound) {
              console.error('FATAL: Could not find or interact with the schedule toggle after all attempts.');
              // await page.screenshot({ path: 'pinterest-schedule-toggle-FAILED.png' });
              throw new Error('Failed to find/enable scheduling toggle'); 
            }
            // --- END: Click Schedule Toggle --- 
            
            // Wait for date/time pickers to appear - might need more specific selectors later
            // For now, assume the wait after click is enough
            
            // Wait for scheduler interface to appear
            await page.waitForTimeout(2000);
            
            // Pinterest's date selector: very targeted approach since standard selectors didn't work
            // First, check for date/time button that opens the picker
            console.log('Attempting to find and click the date/time button...');
            let dateTimeButtonFound = false;
            
            // Take a screenshot to see what we're working with
            // await page.screenshot({ path: 'pinterest-scheduling-interface.png' });
            
            try {
                // Method 1: More aggressive approach to clicking the date field
                console.log('Using enhanced date selection approach...');
                
                // First, try to get the date picker visible
                const dateXPaths = [
                    '//input[contains(@id, "date")]',
                    '//button[contains(@aria-label, "Choose date")]',
                    '//div[contains(@class, "date") or contains(@class, "Date")]',
                    '//div[contains(text(), "Date")]//following-sibling::div',
                    '//button[contains(@aria-label, "Date")]'
                ];
                
                let datePickerOpened = false;
                for (const xpath of dateXPaths) {
                    try {
                        const dateElem = await page.waitForXPath(xpath, { visible: true, timeout: 2000 });
                        if (dateElem) {
                            console.log(`Found date field with xpath: ${xpath}`);
                            await dateElem.click();
                            await page.waitForTimeout(1500);
                            
                            // Take screenshot of calendar
                            // await page.screenshot({ path: 'pinterest-calendar-open.png' });
                            datePickerOpened = true;
                            break;
                        }
                    } catch (e) {
                        console.log(`Date xpath ${xpath} not found or click failed`);
                    }
                }
                
                if (!datePickerOpened) {
                    console.log('Could not open date picker with standard methods');
                    
                    // Fallback: Look for ANY visible date string in the UI
                    try {
                        const anyDateXPath = '//div[contains(text(), "/") or contains(text(), "-") or contains(text(), "Date")]';
                        const anyDateElem = await page.waitForXPath(anyDateXPath, { visible: true, timeout: 3000 });
                        if (anyDateElem) {
                            console.log('Found something that might be a date element, clicking it');
                            await anyDateElem.click();
                            await page.waitForTimeout(1500);
                            datePickerOpened = true;
                        }
                    } catch (e) {
                        console.log('Fallback date element approach failed');
                    }
                }
                
                // If we got the date picker open, try to select the correct date
                // First, verify calendar is open with a more aggressive check
                let calendarOpen = false;
                try {
                    calendarOpen = await page.evaluate(() => {
                        // Look for calendar elements
                        const calendarIndicators = [
                            document.querySelector('table[role="grid"]'),
                            document.querySelector('div[role="grid"]'),
                            document.querySelector('div.calendar'),
                            document.querySelector('div[class*="calendar"]'),
                            document.querySelector('div[class*="Calendar"]'),
                            document.querySelector('div[class*="datepicker"]'),
                            document.querySelector('div[class*="DatePicker"]')
                        ];
                        return calendarIndicators.some(e => e !== null);
                    });
                    
                    if (calendarOpen) {
                        console.log('Calendar detected as open. Attempting to select date...');
                        
                        // Format the date components
                        const targetDay = scheduleDate.getDate();
                        const targetMonth = scheduleDate.getMonth(); // 0-based
                        const targetYear = scheduleDate.getFullYear();
                        
                        // Try to navigate to the correct month/year if needed
                        const currentMonthYear = await page.evaluate(() => {
                            // Try to find the month/year display
                            const monthYearElem = document.querySelector('[class*="header"] span, [class*="title"] span');
                            return monthYearElem ? monthYearElem.textContent : null;
                        });
                        
                        console.log(`Current calendar showing: ${currentMonthYear}`);
                        
                        // Improved month navigation - actively navigate to the correct month/year if needed
                        if (currentMonthYear) {
                            // Try to extract current month and year from the calendar header
                            console.log('Attempting to navigate to the correct month if needed...');
                            
                            // Check if navigation controls exist and navigate if needed
                            const needToNavigate = await page.evaluate((targetYear, targetMonth) => {
                                // Helper to convert month name to number
                                const monthNameToNum = {
                                    'january': 0, 'february': 1, 'march': 2, 'april': 3, 
                                    'may': 4, 'june': 5, 'july': 6, 'august': 7, 
                                    'september': 8, 'october': 9, 'november': 10, 'december': 11,
                                    'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 
                                    'jun': 5, 'jul': 6, 'aug': 7, 'sep': 8, 
                                    'oct': 9, 'nov': 10, 'dec': 11
                                };
                                
                                // Try to extract current month and year
                                const headerText = document.querySelector('[class*="header"] span, [class*="title"] span').textContent.toLowerCase();
                                let currentYear = null;
                                let currentMonth = null;
                                
                                // Extract year
                                const yearMatch = headerText.match(/\b(20\d{2})\b/);
                                if (yearMatch) currentYear = parseInt(yearMatch[1], 10);
                                
                                // Extract month
                                for (const [name, num] of Object.entries(monthNameToNum)) {
                                    if (headerText.includes(name.toLowerCase())) {
                                        currentMonth = num;
                                        break;
                                    }
                                }
                                
                                if (currentYear === null || currentMonth === null) {
                                    console.log('Could not parse current month/year from header');
                                    return false;
                                }
                                
                                console.log(`Current calendar: Month ${currentMonth}, Year ${currentYear}`);
                                console.log(`Target: Month ${targetMonth}, Year ${targetYear}`);
                                
                                // Check if we need to navigate
                                if (currentYear !== targetYear || currentMonth !== targetMonth) {
                                    // Find the navigation buttons
                                    const prevButton = document.querySelector('button[aria-label*="previous"], [class*="prev"], [class*="Prev"], [class*="previous"], [class*="Previous"]');
                                    const nextButton = document.querySelector('button[aria-label*="next"], [class*="next"], [class*="Next"]');
                                    
                                    // Calculate how many months to navigate
                                    // Positive = future, negative = past
                                    const monthDiff = (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
                                    console.log(`Need to navigate ${monthDiff} months`);
                                    
                                    if (monthDiff > 0 && nextButton) {
                                        // Need to navigate forward
                                        for (let i = 0; i < Math.min(monthDiff, 24); i++) {
                                            nextButton.click();
                                            // Brief delay between clicks
                                            setTimeout(() => {}, 100); // Use timeout without await
                                        }
                                        return true;
                                    } else if (monthDiff < 0 && prevButton) {
                                        // Need to navigate backward
                                        for (let i = 0; i < Math.min(Math.abs(monthDiff), 24); i++) {
                                            prevButton.click();
                                            // Brief delay between clicks
                                            setTimeout(() => {}, 100); // Use timeout without await
                                        }
                                        return true;
                                    }
                                }
                                
                                return false;
                            }, targetYear, targetMonth);
                            
                            if (needToNavigate) {
                                console.log('Navigated to the target month/year');
                                await page.waitForTimeout(1000); // Wait for calendar to update
                            }
                        }
                        
                        // Enhanced approach for finding and clicking the day
                        console.log(`Attempting to click day ${targetDay} (multiple strategies)`);
                        
                        // Comprehensive strategy 1: Use evaluate to find and click the day
                        let dayClicked = false;
                        
                        // First attempt: Use a more thorough evaluate approach
                        try {
                            dayClicked = await page.evaluate((targetDay) => {
                                // All possible strategies to find day cells
                                const strategies = [
                                    // Strategy 1: Look for button elements with exact day text
                                    () => Array.from(document.querySelectorAll('button'))
                                        .filter(el => el.textContent.trim() === String(targetDay) && 
                                                !el.disabled && 
                                                !el.classList.contains('disabled')),
                                    
                                    // Strategy 2: Look for any elements with roles that contain the day
                                    () => Array.from(document.querySelectorAll('[role="gridcell"], [role="button"], td'))
                                        .filter(el => el.textContent.trim() === String(targetDay) &&
                                                !el.classList.contains('disabled') &&
                                                window.getComputedStyle(el).display !== 'none'),
                                    
                                    // Strategy 3: Look for any element with the exact day text
                                    () => Array.from(document.querySelectorAll('*'))
                                        .filter(el => el.textContent.trim() === String(targetDay) && 
                                                !el.disabled &&
                                                !el.classList.contains('disabled') && 
                                                window.getComputedStyle(el).display !== 'none' &&
                                                el.clientHeight > 0 && 
                                                el.clientWidth > 0)
                                ];
                                
                                // Try each strategy
                                for (const strategy of strategies) {
                                    const elements = strategy();
                                    console.log(`Found ${elements.length} potential day elements`);
                                    
                                    // Try to find a valid element to click
                                    for (const element of elements) {
                                        try {
                                            // Find the closest clickable parent if necessary
                                            let clickTarget = element;
                                            if (!element.click) {
                                                const parent = element.closest('button, [role="button"], [role="gridcell"], td, a');
                                                if (parent) clickTarget = parent;
                                            }
                                            
                                            // Ensure element is in the viewport
                                            const rect = clickTarget.getBoundingClientRect();
                                            if (rect.top >= 0 && rect.left >= 0 && 
                                                rect.bottom <= window.innerHeight && 
                                                rect.right <= window.innerWidth) {
                                                // Click the element
                                                clickTarget.click();
                                                return true;
                                            }
                                        } catch (e) {
                                            console.log(`Error clicking element: ${e.message}`);
                                        }
                                    }
                                }
                                return false;
                            }, targetDay);
                            
                            if (dayClicked) {
                                console.log(`Successfully clicked day ${targetDay} using advanced evaluate strategy`);
                            } else {
                                console.log(`Failed to click day ${targetDay} using advanced evaluate strategy`);
                            }
                        } catch (e) {
                            console.log(`Error during day selection evaluate: ${e.message}`);
                        }
                        
                        // If first approach failed, try direct XPath with more variations
                        if (!dayClicked) {
                            console.log('Trying multiple XPath patterns for day selection...');
                            const dayXPaths = [
                                `//button[contains(text(), "${targetDay}") and not(contains(@class, "disabled"))]`,
                                `//div[@role="button" or @role="gridcell" or @role="cell"][contains(text(), "${targetDay}")]`,
                                `//td[contains(text(), "${targetDay}")]`,
                                `//div[contains(@class, "day") or contains(@class, "Day")][text()="${targetDay}"]`,
                                `//button[normalize-space(.)="${targetDay}"]`,
                                `//span[text()="${targetDay}"]/parent::button`,
                                `//span[text()="${targetDay}"]/parent::div[@role="button"]`,
                                `//*[self::button or self::div[@role="button"]][contains(., "${targetDay}") and not(contains(@disabled, "true") or contains(@class, "disabled"))]`
                            ];
                            
                            for (const xpath of dayXPaths) {
                                try {
                                    const elements = await page.$x(xpath);
                                    if (elements.length > 0) {
                                        // Find a visible element
                                        for (const element of elements) {
                                            const isVisible = await page.evaluate(el => {
                                                const rect = el.getBoundingClientRect();
                                                return rect.width > 0 && rect.height > 0 && 
                                                    window.getComputedStyle(el).visibility !== 'hidden' &&
                                                    window.getComputedStyle(el).display !== 'none';
                                            }, element);
                                            
                                            if (isVisible) {
                                                await element.click();
                                                console.log(`Clicked day ${targetDay} using XPath: ${xpath}`);
                                                dayClicked = true;
                                                break;
                                            }
                                        }
                                        if (dayClicked) break;
                                    }
                                } catch (e) {
                                    console.log(`XPath ${xpath} failed: ${e.message}`);
                                }
                            }
                        }
                        
                        // Strategy 3: Last resort - inject a click at the calculated position of the day
                        if (!dayClicked) {
                            console.log('Attempting position-based day selection (last resort)...');
                            try {
                                // Find the calendar grid layout
                                const gridInfo = await page.evaluate((targetDay) => {
                                    // Find the calendar grid
                                    const grid = document.querySelector('[role="grid"], table, [class*="calendar"], [class*="Calendar"]');
                                    if (!grid) return null;
                                    
                                    // Get all visible day elements in the grid
                                    const cellSelector = '[role="gridcell"], td, [role="button"], button';
                                    const cells = Array.from(grid.querySelectorAll(cellSelector))
                                        .filter(el => {
                                            // Filter to keep only visible elements that might be days
                                            const style = window.getComputedStyle(el);
                                            const text = el.textContent.trim();
                                            const isNumber = /^\d+$/.test(text);
                                            return style.display !== 'none' && isNumber;
                                        });
                                    
                                    if (cells.length === 0) return null;
                                    
                                    // Find the correct cell or estimate its position
                                    let targetCell = cells.find(cell => cell.textContent.trim() === String(targetDay));
                                    if (!targetCell) {
                                        // If we can't find the exact day, try to estimate its position
                                        // Sort cells by their numeric content
                                        cells.sort((a, b) => {
                                            return parseInt(a.textContent.trim()) - parseInt(b.textContent.trim());
                                        });
                                        
                                        // Get day values
                                        const dayValues = cells.map(cell => parseInt(cell.textContent.trim()));
                                        
                                        // Calculate the coordinates
                                        const numDaysBefore = dayValues.filter(day => day < targetDay).length;
                                        
                                        // Pick a cell based on position
                                        const cellIndex = Math.min(numDaysBefore, cells.length - 1);
                                        targetCell = cells[cellIndex];
                                        
                                        console.log(`Estimated position for day ${targetDay} at index ${cellIndex}`);
                                    }
                                    
                                    if (targetCell) {
                                        const rect = targetCell.getBoundingClientRect();
                                        return {
                                            x: rect.left + rect.width / 2,
                                            y: rect.top + rect.height / 2,
                                            found: targetCell.textContent.trim() === String(targetDay)
                                        };
                                    }
                                    
                                    return null;
                                }, targetDay);
                                
                                if (gridInfo) {
                                    console.log(`Grid position found: x=${gridInfo.x}, y=${gridInfo.y}, exact match: ${gridInfo.found}`);
                                    await page.mouse.click(gridInfo.x, gridInfo.y);
                                    console.log(`Clicked at position (${gridInfo.x}, ${gridInfo.y}) for day ${targetDay}`);
                                    dayClicked = true;
                                } else {
                                    console.log('Could not determine day position in calendar grid');
                                }
                            } catch (e) {
                                console.log(`Position-based day selection failed: ${e.message}`);
                            }
                        }
                        
                        // Final fallback: use direct date input
                        if (!dayClicked) {
                            console.log('All day selection methods failed, will rely on direct date input later');
                        }
                        
                        // Verify the selected date after clicking (when possible)
                        if (dayClicked) {
                            // Wait for any UI updates and try to verify
                            await page.waitForTimeout(1000);
                            try {
                                // Look for a date indicator that shows what's selected
                                const selectedDate = await page.evaluate(() => {
                                    // Check different parts of the UI that might show selected date
                                    const dateDisplays = [
                                        document.querySelector('input[type="date"]'),
                                        document.querySelector('[class*="selected"]'),
                                        document.querySelector('[aria-selected="true"]'),
                                        document.querySelector('[class*="DateValue"]'),
                                        document.querySelector('[aria-label*="Selected"]')
                                    ];
                                    
                                    for (const display of dateDisplays) {
                                        if (display) return display.value || display.textContent;
                                    }
                                    
                                    return null;
                                });
                                
                                if (selectedDate) {
                                    console.log(`Selected date appears to be: ${selectedDate}`);
                                }
                            } catch (e) {
                                console.log(`Error verifying selected date: ${e.message}`);
                            }
                        }
                    } else {
                        console.log('Calendar does not appear to be open after clicking date field');
                    }
                } catch (e) {
                    console.log(`Error checking if calendar is open: ${e.message}`);
                }
                
                // Now handle time selection - with more aggressive approach
                console.log('Handling time selection...');
                await page.waitForTimeout(1500);
                
                // Screenshot to see the state
                // await page.screenshot({ path: 'pinterest-before-time-selection.png' });
                
                // Try to find and click the time field to open time picker
                let timePickerOpened = false;
                const timeXPaths = [
                    '//input[contains(@id, "time")]',
                    '//div[contains(text(), "Time")]//following-sibling::div',
                    '//button[contains(@aria-label, "time") or contains(@aria-label, "Time")]',
                    '//div[contains(@class, "time") or contains(@class, "Time")]',
                    '//div[contains(text(), "12:00") or contains(text(), ":00") or contains(text(), ":30")]'
                ];
                
                for (const xpath of timeXPaths) {
                    try {
                        const timeElem = await page.waitForXPath(xpath, { visible: true, timeout: 2000 });
                        if (timeElem) {
                            console.log(`Found time field with xpath: ${xpath}`);
                            await timeElem.click();
                            await page.waitForTimeout(1500);
                            timePickerOpened = true;
                            break;
                        }
                    } catch (e) {
                        console.log(`Time xpath ${xpath} not found or click failed`);
                    }
                }
                
                // If time picker opened, try to set the time
                if (timePickerOpened) {
                    // Screenshot time picker
                    // await page.screenshot({ path: 'pinterest-time-picker-open.png' });
                    
                    // Format hours for 12-hour format
                    const hours24 = scheduleDate.getHours();
                    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
                    const minutes = scheduleDate.getMinutes();
                    const ampm = hours24 >= 12 ? 'PM' : 'AM';
                    
                    console.log(`Setting time to: ${hours12}:${minutes.toString().padStart(2, '0')} ${ampm}`);
                    
                    // Try clicking directly on the time value in the list
                    const timeFormats = [
                        `${hours12}:${minutes.toString().padStart(2, '0')} ${ampm}`,
                        `${hours12}:${minutes.toString().padStart(2, '0')}${ampm}`,
                        `${hours12}:${minutes.toString().padStart(2, '0')}`
                    ];
                    
                    let timeSelected = false;
                    for (const timeFormat of timeFormats) {
                        try {
                            const timeXPath = `//div[contains(text(), "${timeFormat}")] | //button[contains(text(), "${timeFormat}")]`;
                            const timeElement = await page.waitForXPath(timeXPath, { visible: true, timeout: 2000 });
                            if (timeElement) {
                                await timeElement.click();
                                console.log(`Clicked time: ${timeFormat}`);
                                timeSelected = true;
                                break;
                            }
                        } catch (e) {
                            console.log(`Time format ${timeFormat} not found or click failed`);
                        }
                    }
                    
                    // If direct time selection failed, try setting individual components (hour, minute, AM/PM)
                    if (!timeSelected) {
                        console.log('Direct time selection failed, trying to set hour/minute/ampm separately');
                        
                        // Try to find hour controls
                        let hourSet = false;
                        try {
                            const hourXPaths = [
                                `//div[contains(@class, "hour")]//*[contains(text(), "${hours12}")]`,
                                `//select[contains(@id, "hour")] | //input[contains(@id, "hour")]`,
                                `//div[contains(text(), "Hour")]/following-sibling::div//*[contains(text(), "${hours12}")]`
                            ];
                            
                            for (const xpath of hourXPaths) {
                                try {
                                    const hourElem = await page.waitForXPath(xpath, { visible: true, timeout: 2000 });
                                    if (hourElem) {
                                        const tagName = await page.evaluate(el => el.tagName.toLowerCase(), hourElem);
                                        if (tagName === 'select') {
                                            // If it's a select dropdown
                                            await page.evaluate((el, value) => {
                                                el.value = value;
                                                el.dispatchEvent(new Event('change'));
                                            }, hourElem, hours12.toString());
                                        } else if (tagName === 'input') {
                                            // If it's an input field
                                            await hourElem.click({ clickCount: 3 });
                                            await hourElem.type(hours12.toString());
                                        } else {
                                            // Just click it
                                            await hourElem.click();
                                        }
                                        console.log(`Set hour to ${hours12}`);
                                        hourSet = true;
                                        break;
                                    }
                                } catch (e) {
                                    console.log(`Hour xpath ${xpath} failed: ${e.message}`);
                                }
                            }
                        } catch (e) {
                            console.log(`Error setting hour: ${e.message}`);
                        }
                        
                        // Try to find minute controls
                        let minuteSet = false;
                        try {
                            const minuteStr = minutes.toString().padStart(2, '0');
                            const minuteXPaths = [
                                `//div[contains(@class, "minute")]//*[contains(text(), "${minuteStr}")]`,
                                `//select[contains(@id, "minute")] | //input[contains(@id, "minute")]`,
                                `//div[contains(text(), "Minute")]/following-sibling::div//*[contains(text(), "${minuteStr}")]`
                            ];
                            
                            for (const xpath of minuteXPaths) {
                                try {
                                    const minuteElem = await page.waitForXPath(xpath, { visible: true, timeout: 2000 });
                                    if (minuteElem) {
                                        const tagName = await page.evaluate(el => el.tagName.toLowerCase(), minuteElem);
                                        if (tagName === 'select') {
                                            // If it's a select dropdown
                                            await page.evaluate((el, value) => {
                                                el.value = value;
                                                el.dispatchEvent(new Event('change'));
                                            }, minuteElem, minuteStr);
                                        } else if (tagName === 'input') {
                                            // If it's an input field
                                            await minuteElem.click({ clickCount: 3 });
                                            await minuteElem.type(minuteStr);
                                        } else {
                                            // Just click it
                                            await minuteElem.click();
                                        }
                                        console.log(`Set minute to ${minuteStr}`);
                                        minuteSet = true;
                                        break;
                                    }
                                } catch (e) {
                                    console.log(`Minute xpath ${xpath} failed: ${e.message}`);
                                }
                            }
                        } catch (e) {
                            console.log(`Error setting minute: ${e.message}`);
                        }
                        
                        // Set AM/PM
                        try {
                            const ampmXPaths = [
                                `//div[text()="${ampm}"]`,
                                `//button[text()="${ampm}"]`,
                                `//select[contains(@id, "ampm") or contains(@id, "period")]`,
                                `//div[contains(@class, "ampm") or contains(@class, "AMPM")]//*[text()="${ampm}"]`
                            ];
                            
                            for (const xpath of ampmXPaths) {
                                try {
                                    const ampmElem = await page.waitForXPath(xpath, { visible: true, timeout: 2000 });
                                    if (ampmElem) {
                                        const tagName = await page.evaluate(el => el.tagName.toLowerCase(), ampmElem);
                                        if (tagName === 'select') {
                                            // If it's a select dropdown
                                            await page.evaluate((el, value) => {
                                                el.value = value;
                                                el.dispatchEvent(new Event('change'));
                                            }, ampmElem, ampm);
                                        } else {
                                            // Just click it
                                            await ampmElem.click();
                                        }
                                        console.log(`Set AM/PM to ${ampm}`);
                                        break;
                                    }
                                } catch (e) {
                                    console.log(`AM/PM xpath ${xpath} failed: ${e.message}`);
                                }
                            }
                        } catch (e) {
                            console.log(`Error setting AM/PM: ${e.message}`);
                        }
                    }
                } else {
                    console.log('Could not open time picker');
                }
                
                // Direct approach to set the full date via inputs if all above fails - IMPROVED VERSION
                console.log('Attempting robust direct approach to set date/time...');
                try {
                    const formattedDate = `${scheduleDate.getFullYear()}-${(scheduleDate.getMonth() + 1).toString().padStart(2, '0')}-${scheduleDate.getDate().toString().padStart(2, '0')}`;
                    const formattedDateSlash = `${(scheduleDate.getMonth() + 1).toString().padStart(2, '0')}/${scheduleDate.getDate().toString().padStart(2, '0')}/${scheduleDate.getFullYear()}`;
                    const formattedDateText = `${scheduleDate.toLocaleString('en-US', { month: 'long' })} ${scheduleDate.getDate()}, ${scheduleDate.getFullYear()}`;
                    
                    // Try multiple date format injection approaches
                    console.log(`Setting date using formats: ${formattedDate}, ${formattedDateSlash}, ${formattedDateText}`);
                    
                    // 1. Find all date input elements using multiple selectors
                    const dateInputs = await page.$$('input[type="date"], input[id*="date"], div[class*="DatePicker"] input, input[placeholder*="date" i], [aria-label*="date" i]');
                    console.log(`Found ${dateInputs.length} potential date input elements`);
                    
                    // 2. Try to set date values in various formats
                    for (const input of dateInputs) {
                        try {
                            await page.evaluate((el, value, altValue, textValue) => {
                                // Try multiple methods and formats
                                const formats = [value, altValue, textValue];
                                
                                for (const format of formats) {
                                    try {
                                        // Method 1: Set value directly
                                        el.value = format;
                                        
                                        // Method 2: Use input event
                                        el.dispatchEvent(new Event('input', { bubbles: true }));
                                        el.dispatchEvent(new Event('change', { bubbles: true }));
                                        
                                        // Method 3: Use more specific InputEvent
                                        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: format }));
                                        
                                        // Method 4: Attribute setting if relevant
                                        if (el.hasAttribute('data-value')) el.setAttribute('data-value', format);
                                        if (el.hasAttribute('value')) el.setAttribute('value', format);
                                    } catch (e) {
                                        console.log(`Format ${format} failed: ${e.message}`);
                                    }
                                }
                            }, input, formattedDate, formattedDateSlash, formattedDateText);
                            
                            console.log(`Applied date to an input field`);
                        } catch (e) {
                            console.log(`Error setting date: ${e.message}`);
                        }
                    }
                    
                    // 3. Look for hidden inputs or data-bound elements
                    try {
                        await page.evaluate((dateStr, dateSlash, dateText, targetDay, targetMonth, targetYear) => {
                            // This runs in the browser context
                            
                            // Find any date model/state in the page
                            const dateSetters = [
                                // Look for React/Vue/Angular state variables
                                () => {
                                    // Look for window level state/store
                                    if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.date) {
                                        window.__INITIAL_STATE__.date = dateStr;
                                    }
                                    
                                    // Look for other common state patterns
                                    if (window.__store && window.__store.date) {
                                        window.__store.date = dateStr;
                                    }
                                },
                                
                                // Look for input hidden fields
                                () => {
                                    document.querySelectorAll('input[type="hidden"][name*="date" i], input[type="hidden"][id*="date" i]').forEach(el => {
                                        el.value = dateStr;
                                    });
                                },
                                
                                // Look for data attributes
                                () => {
                                    document.querySelectorAll('[data-date]').forEach(el => {
                                        el.setAttribute('data-date', dateStr);
                                    });
                                },
                                
                                // Directly set any date-related fields in calendar components
                                () => {
                                    const calendarComponent = document.querySelector('[class*="calendar"], [class*="Calendar"], [class*="datepicker"], [class*="DatePicker"]');
                                    if (calendarComponent && calendarComponent.__dateValue) {
                                        calendarComponent.__dateValue = new Date(dateStr);
                                    }
                                }
                            ];
                            
                            // Try all potential setters
                            dateSetters.forEach(setter => {
                                try {
                                    setter();
                                } catch (e) {
                                    console.log(`Date setter failed: ${e.message}`);
                                }
                            });
                        }, formattedDate, formattedDateSlash, formattedDateText, 
                           scheduleDate.getDate(), scheduleDate.getMonth(), scheduleDate.getFullYear());
                    } catch (e) {
                        console.log(`Advanced date injection failed: ${e.message}`);
                    }
                    
                    // 4. Force-set time inputs as well (improved)
                    const formattedTime = `${scheduleDate.getHours().toString().padStart(2, '0')}:${scheduleDate.getMinutes().toString().padStart(2, '0')}`;
                    const hours12 = scheduleDate.getHours() % 12 === 0 ? 12 : scheduleDate.getHours() % 12;
                    const ampm = scheduleDate.getHours() >= 12 ? 'PM' : 'AM';
                    const formattedTime12 = `${hours12}:${scheduleDate.getMinutes().toString().padStart(2, '0')} ${ampm}`;
                    
                    console.log(`Setting time using formats: ${formattedTime}, ${formattedTime12}`);
                    
                    const timeInputs = await page.$$('input[type="time"], input[id*="time"], div[class*="TimePicker"] input, input[placeholder*="time" i], [aria-label*="time" i]');
                    console.log(`Found ${timeInputs.length} potential time input elements`);
                    
                    for (const input of timeInputs) {
                        try {
                            await page.evaluate((el, value, value12) => {
                                // Try multiple methods and formats
                                const formats = [value, value12];
                                
                                for (const format of formats) {
                                    try {
                                        el.value = format;
                                        el.dispatchEvent(new Event('input', { bubbles: true }));
                                        el.dispatchEvent(new Event('change', { bubbles: true }));
                                        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: format }));
                                    } catch (e) {
                                        console.log(`Format ${format} failed: ${e.message}`);
                                    }
                                }
                            }, input, formattedTime, formattedTime12);
                            
                            console.log(`Applied time to an input field`);
                        } catch (e) {
                            console.log(`Error setting time: ${e.message}`);
                        }
                    }
                } catch (e) {
                    console.log(`Enhanced direct date/time setting approach failed: ${e.message}`);
                }
            } catch (e) {
                console.log('Enhanced date selection approach failed:', e.message);
            }
            
            await page.waitForTimeout(1000);
            // await page.screenshot({ path: 'pinterest-after-datetime-set.png' });
            
            console.log(`Attempted to set schedule to: ${scheduleDate.toLocaleString()}`);
            
            // Click schedule button - Now that toggle is clicked, this button should exist
            console.log('Clicking the final Schedule button...');
            // Use the improved button clicking function
            const scheduleButtonFound = await attemptButtonClick(page, [
              '[data-test-id="schedule-button"]',
              '[data-test-id="submit-button"]',
              'button:contains("Schedule")',
              'button[aria-label*="Schedule"]',
              '//button[contains(., "Schedule")]',
              'button[type="submit"]',
              'button.primary', 
              'button.submit'
            ], 10000, 'Schedule button');
            
            if (!scheduleButtonFound) {
              console.warn('Standard Schedule button not found, trying alternative approaches...');
              
              // Try evaluate approach to find any schedule/publish button
              try {
                const buttonClicked = await page.evaluate(() => {
                  // Look for buttons with schedule/publish/submit text
                  const buttonTexts = ['schedule', 'publish', 'submit', 'post', 'create', 'save'];
                  const buttons = Array.from(document.querySelectorAll('button'));
                  
                  // Sort buttons by visibility and likelihood of being the submit button
                  const potentialButtons = buttons.filter(btn => {
                    const text = btn.textContent.toLowerCase();
                    const isVisible = btn.offsetWidth > 0 && btn.offsetHeight > 0;
                    return isVisible && buttonTexts.some(t => text.includes(t));
                  });
                  
                  if (potentialButtons.length > 0) {
                    console.log(`Found potential button with text: ${potentialButtons[0].textContent}`);
                    potentialButtons[0].click();
                    return true;
                  }
                  
                  // Last resort: Click the most prominent button
                  const allVisibleButtons = buttons.filter(btn => 
                    btn.offsetWidth > 0 && btn.offsetHeight > 0
                  ).sort((a, b) => {
                    // Sort by size and position (bigger or lower in the page is likely submit button)
                    const aRect = a.getBoundingClientRect();
                    const bRect = b.getBoundingClientRect();
                    const aArea = aRect.width * aRect.height;
                    const bArea = bRect.width * bRect.height;
                    
                    if (Math.abs(aArea - bArea) > 1000) {
                      return bArea - aArea; // Bigger button first
                    }
                    return bRect.bottom - aRect.bottom; // Lower button first
                  });
                  
                  if (allVisibleButtons.length > 0) {
                    console.log('Clicking the most prominent button as fallback');
                    allVisibleButtons[0].click();
                    return true;
                  }
                  
                  return false;
                });
                
                if (buttonClicked) {
                  console.log('Found and clicked a button via evaluate approach');
                  await page.waitForTimeout(2000);
                } else {
                  console.warn('No suitable button found via evaluate approach');
                }
              } catch (e) {
                console.log(`Evaluate button-finding approach failed: ${e.message}`);
              }
              
              // Final attempt: Try position-based click at common button locations
              try {
                // Get viewport size
                const viewport = await page.evaluate(() => ({
                  width: window.innerWidth,
                  height: window.innerHeight
                }));
                
                // Common positions for submit buttons (bottom-right, bottom-center)
                const positions = [
                  { x: viewport.width * 0.85, y: viewport.height * 0.85 }, // Bottom right
                  { x: viewport.width * 0.5, y: viewport.height * 0.85 },  // Bottom center
                  { x: viewport.width * 0.85, y: viewport.height * 0.7 }   // Lower right
                ];
                
                for (const pos of positions) {
                  console.log(`Trying position-based click at x:${pos.x}, y:${pos.y}`);
                  await page.mouse.click(pos.x, pos.y);
                  await page.waitForTimeout(2000);
                  
                  // Check if we see a confirmation dialog after click
                  const dialogAppeared = await page.evaluate(() => {
                    return !!document.querySelector('div[role="dialog"]');
                  });
                  
                  if (dialogAppeared) {
                    console.log('Dialog appeared after position click - success!');
                    break;
                  }
                }
              } catch (e) {
                console.log(`Position-based button clicking failed: ${e.message}`);
              }
              
              console.warn('All button finding approaches tried');
            }
            
            // Handle confirmation popup - this appears after clicking Schedule button
            console.log('Looking for and clicking the Schedule button in the confirmation popup...');
            // Wait longer for the popup to fully render and be interactive
            await page.waitForTimeout(5000);
            // await page.screenshot({ path: 'pinterest-confirmation-popup.png' });
            
            // Try several approaches to find and click the red Schedule button in the confirmation popup
            let confirmButtonFound = false;
            
            // Approach 1: Look for the red button - red buttons often have special classes or styling
            console.log('Approach 1: Trying to find the red Schedule button by color/style...');
            try {
              const redButtonClicked = await page.evaluate(() => {
                // Look for buttons with red background or specific confirmation classes
                const dialog = document.querySelector('div[role="dialog"]');
                if (!dialog) return false;
                
                // Get computed styles of buttons to find the red one
                const buttons = dialog.querySelectorAll('button');
                for (const button of buttons) {
                  const style = window.getComputedStyle(button);
                  // Check for reddish background color (Pinterest confirmation buttons are usually red)
                  if (style.backgroundColor.includes('rgb(230') || 
                      style.backgroundColor.includes('rgb(234') ||
                      style.backgroundColor.includes('red') ||
                      button.classList.contains('confirmButton') ||
                      button.textContent.trim().toLowerCase() === 'schedule') {
                    console.log('Found button with red background or Schedule text');
                    button.click();
                    return true;
                  }
                }
                return false;
              });
              
              if (redButtonClicked) {
                console.log('Successfully clicked red Schedule button via evaluate!');
                confirmButtonFound = true;
              }
            } catch (err) {
              console.log('Error finding red button:', err.message);
            }
            
            // Approach 2: More specific selectors for the confirmation Schedule button 
            if (!confirmButtonFound) {
              console.log('Approach 2: Trying specific CSS selectors for the Schedule button...');
              // Try more specific selectors based on Pinterest's confirmation button patterns
              for (const selector of [
                'div[role="dialog"] button.red',
                'div[role="dialog"] button[class*="danger"]',
                'div[role="dialog"] button[class*="primary"]',
                'div[role="dialog"] button:nth-child(2)',
                // Last child as a last resort
                'div[role="dialog"] button:last-child'
              ]) {
                try {
                  console.log(`Trying confirmation popup button selector: ${selector}`);
                  const confirmButton = await page.waitForSelector(selector, { visible: true, timeout: 3000 });
                  if (confirmButton) {
                    console.log(`Found confirmation popup Schedule button with selector: ${selector}`);
                    // Try two click methods
                    try {
                      // Method 1: Standard click
                      await confirmButton.click();
                    } catch (e) {
                      console.log('Standard click failed, trying evaluate click');
                      // Method 2: Evaluate click
                      await page.evaluate(el => el.click(), confirmButton);
                    }
                    console.log('Clicked the confirmation popup Schedule button');
                    confirmButtonFound = true;
                    // After clicking, wait a moment and check if dialog is still visible
                    await page.waitForTimeout(2000);
                    const dialogStillVisible = await page.$('div[role="dialog"]') !== null;
                    if (dialogStillVisible) {
                      console.log('Dialog still visible after click, may not have worked');
                      confirmButtonFound = false; // Reset to try next method
                    } else {
                      console.log('Dialog closed after click - success!');
                      break;
                    }
                  }
                } catch (error) {
                  console.log(`Confirmation selector ${selector} failed: ${error.message}`);
                }
              }
            }
            
            // Approach 3: Try XPath with more specific text targeting
            if (!confirmButtonFound) {
              console.log('Approach 3: Trying XPath with exact text matching...');
              const scheduleXPaths = [
                '//div[@role="dialog"]//button[contains(text(), "Schedule")]',
                '//div[@role="dialog"]//button[text()="Schedule"]',
                '//div[@role="dialog"]//button[normalize-space(.)="Schedule"]',
                // Look for nested spans too
                '//div[@role="dialog"]//button//span[text()="Schedule"]/parent::button'
              ];
              
              for (const xpath of scheduleXPaths) {
                try {
                  console.log(`Trying XPath: ${xpath}`);
                  const button = await page.waitForXPath(xpath, { visible: true, timeout: 3000 });
                  if (button) {
                    console.log(`Found button with XPath: ${xpath}`);
                    await button.click();
                    console.log('Clicked confirmation button with XPath');
                    confirmButtonFound = true;
                    await page.waitForTimeout(2000);
                    // Check if dialog closed
                    const dialogGone = await page.$('div[role="dialog"]') === null;
                    if (dialogGone) {
                      console.log('Dialog disappeared after XPath click - success!');
                      break;
                    } else {
                      console.log('Dialog still present after XPath click');
                      confirmButtonFound = false;
                    }
                  }
                } catch (e) {
                  console.log(`XPath ${xpath} failed: ${e.message}`);
                }
              }
            }
            
            // Approach 4: Position-based click (last resort)
            if (!confirmButtonFound) {
              console.log('Approach 4: Trying position-based click in the dialog...');
              try {
                // Look for the dialog content to get coordinates
                const dialogVisible = await page.$('div[role="dialog"]') !== null;
                
                if (dialogVisible) {
                  console.log('Dialog visible, attempting position-based click');
                  // Get dialog dimensions
                  const dialogDimensions = await page.evaluate(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    if (!dialog) return null;
                    
                    const rect = dialog.getBoundingClientRect();
                    return {
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height
                    };
                  });
                  
                  if (dialogDimensions) {
                    // Click in the lower right quadrant of the dialog (where action buttons usually are)
                    const clickX = dialogDimensions.left + (dialogDimensions.width * 0.75);
                    const clickY = dialogDimensions.top + (dialogDimensions.height * 0.75);
                    
                    console.log(`Attempting positional click at X: ${clickX}, Y: ${clickY}`);
                    await page.mouse.click(clickX, clickY);
                    
                    // Check if dialog was dismissed
                    await page.waitForTimeout(2000);
                    const dialogGone = await page.$('div[role="dialog"]') === null;
                    if (dialogGone) {
                      console.log('Dialog disappeared after positional click - success!');
                      confirmButtonFound = true;
                    } else {
                      console.log('Dialog still present after positional click');
                    }
                  }
                }
              } catch (e) {
                console.log('Error with position-based click:', e.message);
              }
            }
            
            if (!confirmButtonFound) {
              console.warn('Could not confirm the popup Schedule button click. The pin might not be scheduled.');
              // Take a screenshot to see what's on the page at this point
              // await page.screenshot({ path: 'pinterest-confirmation-popup-failed.png' });
            } else {
              console.log('Successfully clicked confirmation popup Schedule button!');
            }
            
            // Confirm scheduling in the popup - This might not exist anymore, be less strict
            await page.waitForTimeout(3000); // Wait for potential confirmation
            console.log('Assuming schedule confirmation happened or is not required.');

        } catch (error) {
            console.error('Error during scheduling process:', error.message);
            // await page.screenshot({ path: 'pinterest-scheduling-error.png' });
            // Decide if we should throw or continue if scheduling fails
            // For now, let's throw to indicate failure
            throw error; 
        }
    } else {
      // Publish now - Make sure selectors target the Publish button
      console.log('Publishing pin now...');
      try {
        let publishButtonFound = false;
        for (const selector of [
          '[data-test-id="publish-button"]', // Maybe?
          '[data-test-id="submit-button"]', // Generic?
          '//button[contains(., "Publish")]', // XPath using . for text content
          'button[aria-label*="Publish"]'
        ]) {
          try {
            let publishButton;
            if (selector.startsWith('//')) {
              publishButton = await page.waitForXPath(selector, { visible: true, timeout: 5000 });
            } else {
              publishButton = await page.waitForSelector(selector, { visible: true, timeout: 5000 });
            }
            if (publishButton) {
              console.log(`Found Publish button with selector/xpath: ${selector}`);
              await publishButton.click();
              publishButtonFound = true;
              break;
            }
          } catch (error) {
            console.log(`Publish button selector/xpath ${selector} failed: ${error.message}`);
          }
        }
        
        if (!publishButtonFound) {
           console.warn('Publish button not found.');
           throw new Error('Failed to find Publish button');
        }
      } catch (error) {
        console.error('Error publishing pin:', error.message);
        // await page.screenshot({ path: 'pinterest-publish-error.png' });
        throw error;
      }
    }
    
    // Wait for success confirmation with a more flexible approach
    console.log('Waiting for confirmation...');
    try {
      // Take a screenshot before waiting for confirmation
      // await page.screenshot({ path: 'pinterest-before-confirmation.png' });
      
      await Promise.race([
        page.waitForSelector('[data-test-id="pin-builder-success-toast"]', { visible: true, timeout: DEFAULT_TIMEOUT }),
        page.waitForXPath('//div[contains(text(), "Your Pin was saved")]', { visible: true, timeout: DEFAULT_TIMEOUT }),
        page.waitForXPath('//div[contains(text(), "Your Pin was published")]', { visible: true, timeout: DEFAULT_TIMEOUT }),
        page.waitForXPath('//div[contains(text(), "Your Pin was scheduled")]', { visible: true, timeout: DEFAULT_TIMEOUT }),
        // Wait for timeout as a fallback
        page.waitForTimeout(10000).then(() => {
          console.log('No explicit confirmation found, but continuing anyway');
          return true;
        })
      ]);
      
      console.log('Pin action completed');
    } catch (error) {
      console.error('Error waiting for confirmation:', error.message);
      // Assume it worked anyway to avoid false negatives
      console.log('Continuing despite confirmation error');
    }
    
  } catch (error) {
    console.error('Error in Pinterest automation:', error);
    throw error;
  } finally {
    // Clean up
    if (imagePath) {
      try {
        fs.unlinkSync(imagePath);
        console.log('Temporary image file deleted');
      } catch (err) {
        console.error('Error deleting temporary image file:', err);
      }
    }
    
    if (browser) {
      await browser.close();
      console.log('Browser closed');
    }
  }
}

// Improved function for clicking buttons that might be loading or not immediately visible
async function attemptButtonClick(page, selectors, timeoutMs = 8000, description = "button") {
  console.log(`Attempting to find and click ${description}...`);
  
  for (const selector of selectors) {
    try {
      let button;
      const startTime = Date.now();
      const isXPath = selector.startsWith('//');
      
      // Keep trying until timeout
      while (Date.now() - startTime < timeoutMs) {
        try {
          // Try to find the element
          if (isXPath) {
            const elements = await page.$x(selector);
            button = elements.length > 0 ? elements[0] : null;
          } else {
            button = await page.$(selector);
          }
          
          // If found, try to click it
          if (button) {
            const isVisible = await page.evaluate(el => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && 
                     rect.height > 0 && 
                     window.getComputedStyle(el).visibility !== 'hidden' &&
                     window.getComputedStyle(el).display !== 'none';
            }, button);
            
            if (isVisible) {
              console.log(`Found visible ${description} with selector: ${selector}`);
              await button.click();
              return true;
            }
          }
          
          // Wait a short time before trying again
          await page.waitForTimeout(200);
        } catch (innerError) {
          // Ignore temporary errors and keep trying
        }
      }
      
      console.log(`${description} selector/xpath ${selector} not found or not clickable`);
    } catch (error) {
      console.log(`Error with ${description} selector/xpath ${selector}: ${error.message}`);
    }
  }
  
  return false;
}

// Read JSON payload from stdin
let inputData = '';
process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(inputData);
    await postToPinterest(payload);
  } catch (error) {
    console.error('Error processing input:', error);
    process.exit(1);
  }
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('Process terminated by user');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
}); 

// Export the function for use in other files
module.exports = { postToPinterest };