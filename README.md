# WorkflowMax to Dropbox Folder Sync

## Description

This Node.js application automates the creation of Dropbox folders for new jobs in WorkflowMax (WFM). It polls the WorkflowMax API for new jobs and, upon finding them, creates corresponding job folders within a specified Dropbox Business team space. The application is designed to handle specific folder naming conventions and utilizes a template folder for new job setups.

## Features

*   **WorkflowMax Integration:** Connects to the WorkflowMax API using OAuth 2.0 to fetch job details.
*   **Dropbox Business Integration:** Uses the Dropbox API to create and manage folders within a team namespace.
*   **Automated Polling:** Regularly checks for new jobs in WorkflowMax based on their creation date.
*   **Custom Folder Naming:** Formats folder names as `JOB_NUM - JOB NAME` (all uppercase, underscores converted to hyphens, content in parentheses removed, HTML entities decoded).
*   **Template-Based Folder Creation:** Copies a predefined template folder in Dropbox to create new job folders. Includes a fallback to create an empty folder if the template is not found or if the target folder already exists.
*   **Destination Folder Mapping:** Assigns jobs to specific parent folders in Dropbox based on the first digit of the job number (e.g., jobs starting with '2', '3', '4', '5' go to 'ISA PROJECT JOBS (2-5)').
*   **Duplicate Job Prevention:**
    *   Checks if a folder with the exact formatted name already exists.
    *   Prevents creation of suffixed job folders (e.g., `9000549_1 - JOB NAME`) if a folder for the base job number (e.g., `9000549 - JOB NAME`) already exists in the same parent directory.
*   **OAuth 2.0 Authentication:** Handles WorkflowMax authentication token acquisition and refresh.
*   **Environment Variable Configuration:** Uses a `.env` file for secure management of API keys, tokens, and other settings.
*   **Logging:** Provides detailed logging for monitoring and debugging.

## Setup Instructions

### Prerequisites

*   Node.js (v14.x or later recommended)
*   npm (or yarn)
*   Access to a WorkflowMax account with API access enabled.
*   Access to a Dropbox Business account with an App created (with appropriate permissions for files and team information).

### Environment Variables

Create a `.env` file in the root of the project directory and populate it with the following variables:

```env
# WorkflowMax API Credentials
WFX_CLIENT_ID=YOUR_WFM_CLIENT_ID
WFX_CLIENT_SECRET=YOUR_WFM_CLIENT_SECRET
WFX_ACCOUNT_ID=YOUR_WFM_ACCOUNT_KEY_OR_ID

# Dropbox API Credentials
DROPBOX_TOKEN=YOUR_DROPBOX_ACCESS_TOKEN
# Optional: Specify the root folder path in Dropbox if needed, though the app uses namespace ID primarily.
# DROPBOX_ROOT=/Your/Dropbox/Root/Path

# Application Configuration
PORT=3000 # Port the application will run on
CALLBACK_URL=http://localhost:3000/oauth/callback # Or your ngrok/production URL for OAuth callback

# Dropbox Team Member and Namespace Configuration
# The email of the Dropbox team member in whose context API calls will be made.
# This user MUST have access to the team folders and the template folder.
DROPBOX_API_SELECT_USER_EMAIL=your_dropbox_team_member_email@example.com

# The Namespace ID for the Dropbox team folder.
# You may need to discover this ID using the Dropbox API (e.g., via team/namespaces/list).
# The current hardcoded value is '10371174816' for "Innovative Surveying Public (alternate)".
# You might need to update NAMESPACE_ID in index.js if this differs for your setup.

# Template Folder Path (relative to the root of the Namespace)
# Update TEMPLATE_PATH in index.js if your template folder is different.
# Example: 'ISA SURVEYORS PTY LTD (6 or 9)/00_ISA SURVEYORS JOB FOLDER TEMPLATE'
```

**Note on `NAMESPACE_ID` and `TEMPLATE_PATH`:**
The `NAMESPACE_ID` and `TEMPLATE_PATH` are currently hardcoded in `index.js`. You will need to:
1.  Verify or find your correct Dropbox Team Namespace ID.
2.  Update the `NAMESPACE_ID` constant in `index.js` if necessary.
3.  Update the `TEMPLATE_PATH` constant in `index.js` to point to your desired template folder within that namespace. The path should be relative to the root of the namespace.

### Installation

1.  Clone the repository (if applicable).
2.  Navigate to the project directory:
    ```bash
    cd path/to/your/project
    ```
3.  Install dependencies:
    ```bash
    npm install
    ```

### Running the Application

1.  Start the application:
    ```bash
    node index.js
    ```
2.  The server will start, typically on `http://localhost:3000`.

## Authentication with WorkflowMax

1.  Once the application is running, open your web browser and navigate to `http://localhost:3000/oauth/login` (or the appropriate URL if `PORT` or `CALLBACK_URL` is different).
2.  This will redirect you to the WorkflowMax login and authorization page.
3.  Log in with your WorkflowMax credentials and authorize the application.
4.  Upon successful authorization, you will be redirected back to the `CALLBACK_URL`, and the application will store the necessary OAuth tokens in a `wfx_tokens.json` file.
5.  The application will automatically use these tokens and refresh them when needed.

## Polling Mechanism

The application uses `node-schedule` to poll the WorkflowMax API every minute (configurable in `index.js`). 
- **Initial Sync:** On its first run after startup, the application looks back 24 hours and attempts to sync jobs created or modified within that period.
- **Ongoing Sync:** After the initial sync, it polls for jobs created or modified since the last successful check.
- **Pre-existing Jobs:** The application does not automatically go back and create folders for all historical jobs in WorkflowMax beyond the initial 24-hour window. It processes jobs as they appear "new" or "recently modified" according to the WorkflowMax API within its polling window. If an old job is updated in WorkflowMax in a way that makes it appear in the API results for recent jobs, it would then be processed.

## Logging

The application logs its activities to the console with timestamps. This includes:
*   Server startup
*   OAuth token operations (acquisition, refresh)
*   Polling activity (fetching jobs, number of jobs found)
*   Job processing details (job number, name, destination folder)
*   Folder creation attempts (success, failure, template usage, fallbacks)
*   Errors encountered during any operation.

## Key Technologies

*   **Node.js:** JavaScript runtime environment.
*   **Express.js:** Web framework for Node.js.
*   **Axios:** Promise-based HTTP client for making API requests.
*   **dotenv:** Module to load environment variables from a `.env` file.
*   **node-schedule:** Job scheduler for Node.js.

## How it Works

1.  **Initialization:**
    *   On startup, the server initializes, loads environment variables, and attempts to identify the specified Dropbox team member (`DROPBOX_API_SELECT_USER_EMAIL`).
    *   It then lists the contents of the root of the configured Dropbox namespace (`NAMESPACE_ID`) to find and map the paths for the primary destination folders (e.g., "ISA PROJECT JOBS", "ISA SURVEY PTY LTD", "ISA SURVEYORS PTY LTD"). These mappings are stored in `global.folderIds`.
    *   If these folders are not found, a critical error is logged, and job processing might be impaired.
    *   The `lastChecked` time for polling WorkflowMax is initialized to 24 hours prior to the current time.

2.  **OAuth Flow:**
    *   The `/oauth/login` endpoint initiates the OAuth 2.0 flow with WorkflowMax.
    *   The `/oauth/callback` endpoint handles the response from WorkflowMax, exchanges the authorization code for an access token and refresh token, and saves them to `wfx_tokens.json`.

3.  **Job Polling:**
    *   A scheduled job runs every minute.
    *   It ensures valid WorkflowMax access tokens are available (refreshing if necessary).
    *   It fetches jobs from the WorkflowMax API using the `from` parameter set to `lastChecked` and `to` set to the current time. On the very first run, `lastChecked` is 24 hours in the past.
    *   The response from WFM can be XML or JSON, and the application attempts to parse it accordingly.
    *   After successfully processing jobs, `lastChecked` is updated to the current time for the next polling cycle.

4.  **Job Processing:**
    *   For each new job:
        *   The base job number is extracted (e.g., `9000549` from `9000549_1`).
        *   The destination parent folder in Dropbox is determined using `selectDestinationFolder` based on the job number's first digit.
        *   The job folder name is formatted using `formatJobName`.
        *   `checkFolderExists` verifies if a folder with the exact formatted name already exists.
        *   If the job number has a suffix (e.g., `_1`), `checkExistingJobFolders` checks (using a regex) if a folder for the base job number already exists to prevent duplicates like `9000549 - JOB NAME` and `9000549_1 - JOB NAME`.
        *   If no duplicates are found, `createFolderFromTemplate` is called:
            *   It attempts to copy the `TEMPLATE_PATH` to the `destination_parent_path/formatted_job_folder_name`.
            *   **Fallback 1 (Template Not Found):** If the `TEMPLATE_PATH` is not found, it falls back to calling `createFolder` to create an empty folder.
            *   **Fallback 2 (Target Exists/Conflict):** If copying the template results in a conflict (target folder already exists), it assumes success. If any other error occurs during copy, it also falls back to `createFolder`.
        *   `createFolder` creates an empty folder at the specified path. If it encounters a conflict, it assumes the folder already exists.
    *   Logs are generated for each step.

5.  **Token Management:**
    *   WorkflowMax access tokens are automatically refreshed before they expire.

</rewritten_file> 