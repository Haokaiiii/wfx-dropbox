// index.js
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import path from 'path';
import schedule from 'node-schedule';

dotenv.config();
const {
  WFX_CLIENT_ID,
  WFX_CLIENT_SECRET,
  WFX_ACCOUNT_ID,     // Your WorkflowMax Org ID
  DROPBOX_TOKEN,
  DROPBOX_ROOT,
  PORT = 3000
} = process.env;

const AUTH_URL    = 'https://oauth.workflowmax2.com/oauth/authorize';
const TOKEN_URL   = 'https://oauth.workflowmax2.com/oauth/token';
const WFX_API_URL = 'https://api.workflowmax2.com/job.api/list';
const TOKEN_FILE  = path.join(process.cwd(), 'wfx_tokens.json');
const NAMESPACE_ID = '10371174816'; // "Innovative Surveying Public (alternate)"
const TEMPLATE_PATH = 'ISA SURVEYORS PTY LTD (6 or 9)/00_ISA SURVEYORS JOB FOLDER TEMPLATE'; // Template folder path

// Create Express app
const app = express();
app.set('trust proxy', true);
app.use(bodyParser.json());

// Logging utility function
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  
  if (data) {
    console.log(logMessage, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(logMessage);
  }
}

// Root route handler
app.get('/', (req, res) => {
  res.send(`
    <h1>WorkflowMax to Dropbox Integration</h1>
    <p>This service automatically creates Dropbox folders for new WorkflowMax jobs.</p>
    <p>To authenticate with WorkflowMax, visit <a href="/oauth/login">/oauth/login</a></p>
  `);
});

// --- Helpers to read/write WorkflowMax tokens ---
async function readTokens() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeTokens(tokens) {
  tokens.obtained_at = Date.now();
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

// --- Exchange or refresh access_token as needed ---
async function getValidAccessToken() {
  let tokens = await readTokens();
  const now = Date.now();
  const tokenExpiry = tokens.obtained_at + tokens.expires_in * 1000 - 60000;
  
  log(`Token check - Current time: ${now}, Token expiry: ${tokenExpiry}`);
  
  if (!tokens.access_token || tokenExpiry < now) {
    log("Access token expired or missing, refreshing token...");
    // Refresh flow
    try {
      const payload = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id:     WFX_CLIENT_ID,
        client_secret: WFX_CLIENT_SECRET
      });
      
      log("Sending refresh token request...");
      const { data } = await axios.post(TOKEN_URL, payload.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      
      log("Token refresh successful", { expires_in: data.expires_in });
      await writeTokens(data);
      return data.access_token;
    } catch (error) {
      log("Token refresh failed", error.response?.data || error.message);
      throw error;
    }
  }
  
  log("Using existing valid access token");
  return tokens.access_token;
}

// --- Decide which Dropbox sub-folder to use ---
function selectDestinationFolder(jobNo) {
  if (!jobNo || typeof jobNo !== 'string') {
    log(`❌ Invalid job number: ${jobNo}`);
    return null;
  }
  
  const p = jobNo.charAt(0);
  
  // Check which folder exists in our folderIds
  if ('2345'.includes(p)) {
    const folderPath = global.folderIds['ISA PROJECT JOBS (2-5)'];
    if (!folderPath) {
      log(`❌ Folder 'ISA PROJECT JOBS (2-5)' not found for job ${jobNo}`);
      return null;
    }
    return folderPath;
  }
  
  if ('78'.includes(p)) {
    const folderPath = global.folderIds['ISA SURVEY PTY LTD (7-8)'];
    if (!folderPath) {
      log(`❌ Folder 'ISA SURVEY PTY LTD (7-8)' not found for job ${jobNo}`);
      return null;
    }
    return folderPath;
  }
  
  if ('69'.includes(p)) {
    const folderPath = global.folderIds['ISA SURVEYORS PTY LTD (6 or 9)'];
    if (!folderPath) {
      log(`❌ Folder 'ISA SURVEYORS PTY LTD (6 or 9)' not found for job ${jobNo}`);
      return null;
    }
    return folderPath;
  }
  
  // Jobs starting with '1' or any other character should be ignored
  log(`⚠️ Job number ${jobNo} doesn't match any folder pattern`);
  return null;
}

// --- OAuth Login Redirect ---
app.get('/oauth/login', (req, res) => {
  // Dynamic callback URL for production
  const callbackUrl = process.env.CALLBACK_URL || `${req.protocol}://${req.get('host')}/oauth/callback`;
  
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     WFX_CLIENT_ID,
    redirect_uri:  callbackUrl,
    scope:         'openid profile email workflowmax offline_access',
    state:         'xyz123',   // replace with a real random state in production
    prompt:        'consent'
  });
  res.redirect(`${AUTH_URL}?${params}`);
});

// OAuth callback handler
app.get('/oauth/callback', async (req, res) => {
  log("OAuth callback received", req.query);
  const { code, error, error_description } = req.query;
  if (error) {
    log(`OAuth Error: ${error_description}`);
    return res.status(400).send(`OAuth Error: ${error_description}`);
  }
  try {
    log("Exchanging authorization code for tokens");
    const payload = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  `${req.protocol}://${req.get('host')}/oauth/callback`,
      client_id:     WFX_CLIENT_ID,
      client_secret: WFX_CLIENT_SECRET
    });
    const { data } = await axios.post(TOKEN_URL, payload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    log("Token exchange successful", { expires_in: data.expires_in });
    await writeTokens(data);
    res.send('✅ OAuth successful! Tokens saved.');
  } catch (e) {
    log("Token exchange failed", e.response?.data || e.message);
    res.status(500).send('Token exchange failed');
  }
});

// --- Poll WorkflowMax API every minute for new Jobs ---
let lastChecked = new Date(Date.now() - 24 * 60 * 60 * 1000); // Look back 24 hours initially

// Get team members
async function getTeamMembers() {
  try {
    log('Fetching Dropbox team members...');
    const response = await axios({
      method: 'post',
      url: 'https://api.dropboxapi.com/2/team/members/list',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/json'
      },
      data: {
        limit: 100
      }
    });
    
    if (response.data.members && response.data.members.length > 0) {
      log(`✅ Found ${response.data.members.length} team members`);
      return response.data.members;
    } else {
      log('No team members found');
      return [];
    }
  } catch (error) {
    log('❌ Error getting team members:', error.response?.data || error.message);
    return [];
  }
}

// Find team member by email
function findTeamMemberByEmail(teamMembers, email) {
  if (!teamMembers || !Array.isArray(teamMembers)) {
    return null;
  }
  
  const member = teamMembers.find(member => 
    member.profile && 
    member.profile.email && 
    member.profile.email.toLowerCase() === email.toLowerCase()
  );
  
  return member ? member.profile.team_member_id : null;
}

// Helper function to format job name according to requirements
function formatJobName(jobNo, jobName) {
  // Remove HTML entities
  let formattedName = jobName.replace(/&amp;/g, '&')
                             .replace(/&lt;/g, '<')
                             .replace(/&gt;/g, '>')
                             .replace(/&quot;/g, '"')
                             .replace(/&#39;/g, "'");
  
  // Remove content in parentheses
  formattedName = formattedName.replace(/\s*\([^)]*\)/g, '');
  
  // Replace underscores with " - "
  formattedName = formattedName.replace(/_/g, ' - ');
  
  // Convert to uppercase
  formattedName = formattedName.toUpperCase();
  
  // Clean up multiple spaces
  formattedName = formattedName.replace(/\s+/g, ' ').trim();
  
  // Format the final folder name
  return `${jobNo} - ${formattedName}`;
}

// Helper function to check if a folder already exists
async function checkFolderExists(parentPath, folderName) {
  try {
    const headers = {
      'Authorization': `Bearer ${DROPBOX_TOKEN}`,
      'Content-Type': 'application/json',
      'Dropbox-API-Select-User': global.teamMemberId,
      'Dropbox-API-Path-Root': JSON.stringify({
        ".tag": "namespace_id",
        "namespace_id": global.dropboxNamespaceId
      })
    };
    
    const response = await axios({
      method: 'post',
      url: 'https://api.dropboxapi.com/2/files/get_metadata',
      headers: headers,
      data: {
        path: `${parentPath}/${folderName}`,
        include_deleted: false
      }
    });
    
    return true; // Folder exists
  } catch (error) {
    if (error.response?.data?.error?.['.tag'] === 'path' && 
        error.response?.data?.error?.path?.['.tag'] === 'not_found') {
      return false; // Folder doesn't exist
    }
    // Other errors, assume folder doesn't exist
    return false;
  }
}

// Schedule job to poll WorkflowMax API every minute
schedule.scheduleJob('*/1 * * * *', async () => {
  log("Starting job polling...");
  try {
    // Check if folderIds is properly initialized
    if (!global.folderIds || Object.keys(global.folderIds).length === 0) {
      log("❌ ERROR: No destination folders have been found and mapped. Cannot create folders for jobs.");
      log("Please check that your Dropbox token has access to the correct team folders and try restarting the application.");
      return; // Skip job processing to avoid errors
    }
    
    // Ensure teamMemberId is available
    if (!global.teamMemberId) {
      log("❌ ERROR: Team member ID is not available. Cannot create folders in user context.");
      return;
    }

    log(`Last checked time: ${lastChecked.toISOString()}`);
    const accessToken = await getValidAccessToken();
    
    const since = lastChecked.toISOString();
    const now = new Date();
    const to = now.toISOString();
    
    log(`Fetching jobs from ${since} to ${to}`);
    
    const response = await axios.get(WFX_API_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        account_id:    WFX_ACCOUNT_ID,
        Accept:        'application/json'
      },
      params: { 
        from: since,
        to: to
      },
      // Don't automatically transform the response
      transformResponse: [(data) => data]
    });
    
    // Log the raw response for debugging
    log("Raw API response:", response.data.substring(0, 500) + (response.data.length > 500 ? '...' : ''));
    
    let jobs = [];
    
    // Check if response is XML (starts with <?xml)
    if (typeof response.data === 'string' && response.data.trim().startsWith('<?xml')) {
      log("Received XML response, attempting to parse");
      // Basic XML parsing - extract Job elements
      const jobMatches = response.data.match(/<Job>(.*?)<\/Job>/gs);
      
      if (jobMatches && jobMatches.length > 0) {
        log(`Found ${jobMatches.length} job(s) in XML response`);
        
        jobs = jobMatches.map(jobXml => {
          // Extract basic job info from XML
          const idMatch = jobXml.match(/<ID>(.*?)<\/ID>/);
          const nameMatch = jobXml.match(/<Name>(.*?)<\/Name>/);
          const dateMatch = jobXml.match(/<DateCreated>(.*?)<\/DateCreated>/) || 
                           jobXml.match(/<DateCreatedUtc>(.*?)<\/DateCreatedUtc>/);
          
          return {
            ID: idMatch ? idMatch[1] : 'unknown',
            Name: nameMatch ? nameMatch[1] : 'unknown',
            DateCreated: dateMatch ? dateMatch[1] : new Date().toISOString()
          };
        });
      }
    } else if (response.data) {
      // Try to parse as JSON
      try {
        const parsedData = JSON.parse(response.data);
        log("Parsed JSON response", { 
          hasResponse: !!parsedData.Response,
          hasJobs: !!(parsedData.Response && parsedData.Response.Job)
        });
        
        jobs = parsedData.Response?.Job || [];
        if (!Array.isArray(jobs) && jobs) {
          jobs = [jobs];
        }
      } catch (parseError) {
        log("Failed to parse response as JSON", parseError.message);
      }
    }
    
    log(`Processing ${jobs.length} job(s)`);

    // Keep track of processed job IDs to avoid duplicates
    const processedJobs = new Set();

    for (let job of jobs) {
      const jobNo = job.ID;  // Using ID as shown in the API example
      
      // Extract base job number for duplicate checking (remove _1, _2 suffixes)
      const baseJobNo = jobNo.split('_')[0];
      
      // Skip if we've already processed this job in this polling cycle
      if (processedJobs.has(jobNo)) {
        log(`Skipping duplicate job: ${jobNo}`);
        continue;
      }
      processedJobs.add(jobNo);
      
      const created = new Date(job.DateCreatedUtc || job.DateCreated);
      log(`Processing job: ${jobNo || "Unknown"}, Created: ${created.toISOString()}`);
      
      const jobName = job.Name;  // Using Name as shown in the API example
      const destFolderPath = selectDestinationFolder(jobNo);
      
      // Skip jobs that don't have a valid destination folder (e.g., jobs starting with '1')
      if (!destFolderPath) {
        log(`Skipping job ${jobNo} - No valid destination folder for this job prefix`);
        continue;
      }
      
      // Format the job folder name according to requirements
      const jobFolderName = formatJobName(jobNo, jobName);
      
      // Check if folder already exists
      const folderExists = await checkFolderExists(destFolderPath, jobFolderName);
      if (folderExists) {
        log(`Folder already exists for job ${jobNo}: ${jobFolderName}`);
        continue;
      }
      
      // Also check if base job folder exists (for duplicates like 9000549 and 9000549_1)
      if (jobNo.includes('_')) {
        const baseJobFolderPattern = new RegExp(`^${baseJobNo}\\s*-\\s*`, 'i');
        const existingFolders = await checkExistingJobFolders(destFolderPath, baseJobFolderPattern);
        if (existingFolders.length > 0) {
          log(`⚠️ Found existing folder(s) for base job ${baseJobNo}: ${existingFolders.join(', ')}`);
          log(`Skipping duplicate job: ${jobNo}`);
          continue;
        }
      }
      
      // Try to create the folder by copying the template
      const success = await createFolderFromTemplate(destFolderPath, jobFolderName);
      
      if (success) {
        log(`✅ Successfully created folder for job ${jobNo}: ${destFolderPath}/${jobFolderName}`);
      } else {
        log(`❌ Failed to create folder for job ${jobNo}`);
      }
    }

    lastChecked = new Date();
    log(`Updated last checked time to: ${lastChecked.toISOString()}`);
  } catch (err) {
    log("❌ Polling error", err.response?.data || err.message);
    // If there's an XML error response, log it more clearly
    if (typeof err.response?.data === 'string' && err.response.data.includes('<?xml')) {
      log("XML Error Response:", err.response.data);
    }
  }
});

// Function to check existing job folders by pattern
async function checkExistingJobFolders(parentPath, pattern) {
  try {
    const headers = {
      'Authorization': `Bearer ${DROPBOX_TOKEN}`,
      'Content-Type': 'application/json',
      'Dropbox-API-Select-User': global.teamMemberId,
      'Dropbox-API-Path-Root': JSON.stringify({
        ".tag": "namespace_id",
        "namespace_id": global.dropboxNamespaceId
      })
    };
    
    const response = await axios({
      method: 'post',
      url: 'https://api.dropboxapi.com/2/files/list_folder',
      headers: headers,
      data: {
        path: parentPath,
        recursive: false,
        include_deleted: false
      }
    });
    
    const entries = response.data.entries || [];
    return entries
      .filter(entry => entry['.tag'] === 'folder' && pattern.test(entry.name))
      .map(entry => entry.name);
  } catch (error) {
    log(`Error checking existing folders: ${error.message}`);
    return [];
  }
}

// Function to create a folder by copying from template
async function createFolderFromTemplate(parentPath, folderName) {
  try {
    log(`Attempting to create folder "${folderName}" by copying template`);
    
    const headers = {
      'Authorization': `Bearer ${DROPBOX_TOKEN}`,
      'Content-Type': 'application/json',
      'Dropbox-API-Select-User': global.teamMemberId,
      'Dropbox-API-Path-Root': JSON.stringify({
        ".tag": "namespace_id",
        "namespace_id": global.dropboxNamespaceId
      })
    };
    
    try {
      // Copy the template folder to create the new job folder
      const copyResponse = await axios({
        method: 'post',
        url: 'https://api.dropboxapi.com/2/files/copy_v2',
        headers: headers,
        data: {
          from_path: TEMPLATE_PATH,
          to_path: `${parentPath}/${folderName}`,
          autorename: false
        }
      });
      
      if (copyResponse.data && copyResponse.data.metadata) {
        log(`✅ Created folder from template: ${copyResponse.data.metadata.name} at path: ${copyResponse.data.metadata.path_display}`);
        return copyResponse.data.metadata;
      } else {
        log(`⚠️ Unexpected response format when copying template`);
        // Fall back to creating empty folder
        return createFolder(parentPath, folderName);
      }
    } catch (error) {
      if (error.response?.data?.error_summary?.includes('path/conflict')) {
        log(`Folder already exists: ${folderName}`);
        return { name: folderName, path_display: `${parentPath}/${folderName}` };
      } else if (error.response?.data?.error_summary?.includes('path/not_found')) {
        log(`Template folder not found at: ${TEMPLATE_PATH}, creating empty folder instead`);
        // Fall back to creating empty folder
        return createFolder(parentPath, folderName);
      }
      
      log(`❌ Error copying template: ${error.response?.data?.error_summary || error.message}`);
      // Fall back to creating empty folder
      return createFolder(parentPath, folderName);
    }
  } catch (error) {
    log(`❌ Unexpected error in createFolderFromTemplate: ${error.message}`);
    return null;
  }
}

// Function to create a folder in Dropbox
async function createFolder(parentPath, folderName) {
  try {
    log(`Attempting to create folder "${folderName}" in path: ${parentPath}`);
    
    // Use Path-Root header approach with namespace for team folders
    const headers = {
      'Authorization': `Bearer ${DROPBOX_TOKEN}`,
      'Content-Type': 'application/json',
      'Dropbox-API-Select-User': global.teamMemberId,
      'Dropbox-API-Path-Root': JSON.stringify({
        ".tag": "namespace_id",
        "namespace_id": global.dropboxNamespaceId
      })
    };
    
    try {
      const createResponse = await axios({
        method: 'post',
        url: 'https://api.dropboxapi.com/2/files/create_folder_v2',
        headers: headers,
        data: {
          path: `${parentPath}/${folderName}`,
          autorename: false
        }
      });
      
      if (createResponse.data && createResponse.data.metadata) {
        log(`✅ Created folder: ${createResponse.data.metadata.name} at path: ${createResponse.data.metadata.path_display}`);
        return createResponse.data.metadata;
      } else {
        log(`⚠️ Unexpected response format when creating folder`);
        return null;
      }
    } catch (error) {
      // Check if folder already exists
      if (error.response?.data?.error_summary?.includes('path/conflict/folder')) {
        log(`Folder already exists: ${folderName}`);
        return { name: folderName, path_display: `${parentPath}/${folderName}` };
      }
      
      log(`❌ Error creating folder: ${error.response?.data?.error_summary || error.message}`);
      return null;
    }
  } catch (error) {
    log(`❌ Unexpected error in createFolder: ${error.message}`);
    return null;
  }
}

// Start the server and initialize the application
app.listen(PORT, async () => {
  log(`🚀 Server listening on http://localhost:${PORT}`);
  
  // Get team members and use the specific member by email
  const teamMembers = await getTeamMembers();
  if (teamMembers.length > 0) {
    const specificEmail = process.env.DROPBOX_API_SELECT_USER_EMAIL || 'mings@isagroups.com.au';
    global.teamMemberId = findTeamMemberByEmail(teamMembers, specificEmail);
    
    if (global.teamMemberId) {
      log(`✅ Found and using team member: ${specificEmail} (ID: ${global.teamMemberId})`);
    } else {
      log(`❌ Could not find team member with email: ${specificEmail}`);
      log('Available team members:');
      teamMembers.forEach((member, index) => {
        log(`${index + 1}. ${member.profile.email} (${member.profile.team_member_id})`);
      });
      return;
    }

    log(`Using team member ID: ${global.teamMemberId} for Dropbox operations.`);
  } else {
    log('❌ No team members found');
    return;
  }
  
  global.dropboxNamespaceId = NAMESPACE_ID;
  log(`Using known namespace ID: ${global.dropboxNamespaceId} for Innovative Surveying Public (alternate)`);
  
  let foundFolders = false;
  
  // Try using Path-Root header with the namespace ID
  try {
    log(`Attempting to access using Path-Root header with namespace ID...`);
    
    const folderContents = await axios({
      method: 'post',
      url: 'https://api.dropboxapi.com/2/files/list_folder',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/json',
        'Dropbox-API-Select-User': global.teamMemberId,
        'Dropbox-API-Path-Root': JSON.stringify({
          ".tag": "namespace_id",
          "namespace_id": global.dropboxNamespaceId
        })
      },
      data: {
        path: "",
        recursive: false,
        include_deleted: false,
        include_mounted_folders: true
      }
    });
    
    if (folderContents.data && folderContents.data.entries) {
      log(`Found ${folderContents.data.entries.length} items using Path-Root header.`);
      
      // Look for the required subfolders
      const isaProjectJobs = folderContents.data.entries.find(entry => 
        entry.name.includes("ISA PROJECT JOBS"));
      
      const isaSurvey = folderContents.data.entries.find(entry => 
        entry.name.includes("ISA SURVEY PTY LTD"));
      
      const isaSurveyors = folderContents.data.entries.find(entry => 
        entry.name.includes("ISA SURVEYORS PTY LTD"));
      
      if (isaProjectJobs && isaSurvey && isaSurveyors) {
        log(`✅ Found all required job subfolders using Path-Root header!`);
        global.folderIds = {
          'ISA PROJECT JOBS (2-5)': isaProjectJobs.path_lower || isaProjectJobs.id,
          'ISA SURVEY PTY LTD (7-8)': isaSurvey.path_lower || isaSurvey.id,
          'ISA SURVEYORS PTY LTD (6 or 9)': isaSurveyors.path_lower || isaSurveyors.id
        };
        foundFolders = true;
        log(`Folder IDs mapped successfully:`);
        log(`ISA PROJECT JOBS: ${global.folderIds['ISA PROJECT JOBS (2-5)']}`);
        log(`ISA SURVEY PTY LTD: ${global.folderIds['ISA SURVEY PTY LTD (7-8)']}`);
        log(`ISA SURVEYORS PTY LTD: ${global.folderIds['ISA SURVEYORS PTY LTD (6 or 9)']}`);
      } else {
        log(`❌ Could not find all required job subfolders using Path-Root header`);
      }
    }
  } catch (error) {
    log(`❌ Error using Path-Root header approach: ${error.response?.data?.error_summary || error.message}`);
  }

  // If we haven't found the folders, log a critical error
  if (!foundFolders) {
    log(`❌ CRITICAL: Could not find the required folders. 
Please verify your Dropbox token permissions and the correct folder structure.`);
  }
});
