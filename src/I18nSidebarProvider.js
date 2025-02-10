const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

class I18nSidebarProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(webviewView) {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log("Received message:", message.sentences);

      if (message.command === "testApi") {
        try {
          const prompt = `
                    Tạo JSON với key i18n cho các câu sau, dịch sang các ngôn ngữ: ${message.languages}. 
                    Định dạng JSON yêu cầu: 
                    
                    {
                      eng: {
                        [key]: "English translation"
                        ...,
                      },
                      vie: {
                        [key]: "Vietnamese translation"
                        ...,
                      }
                      ...
                    }
                    
                    Dưới đây là danh sách các câu cần dịch, cách nhau bởi dấu xuống dòng:
                    ${message.sentences}
                    
                    Chỉ trả về JSON, không giải thích hay văn bản phụ trợ.
                    `;

          const res = await axios.post(
            message.apiUrl,
            { prompt: prompt, stream: false, model: "qwen2.5" },
            {
              headers: { Authorization: `Bearer ${message.apiKey}` },
            }
          );

          const jsonResponse = this.extractJsonFromResponse(res.data.response);

          console.log("API response:", jsonResponse);
          webviewView.webview.postMessage({
            command: "apiResponse",
            success: true,
            data: jsonResponse,
          });
        } catch (error) {
          console.log("API error:", error.message);

          webviewView.webview.postMessage({
            command: "apiResponse",
            success: false,
            error: error.message,
          });
        }
      } else if (message.command === "selectFile") {
        // Xử lý khi người dùng muốn chọn file
        const fileUri = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: {
            "Text Files": ["txt"],
          },
        });

        if (fileUri && fileUri[0]) {
          const fileContent = await vscode.workspace.fs.readFile(fileUri[0]);
          const text = Buffer.from(fileContent).toString("utf8");
          webviewView.webview.postMessage({
            command: "fileSelected",
            path: fileUri[0].fsPath,
            content: text,
          });
        }
      } else if (message.command === "generate") {
        console.log("Generating translations...");
        try {
          const translations = await generateTranslations(message, this);
          if (!translations) {
            throw new Error("No translations generated");
          }

          // Sử dụng đường dẫn file từ message
          if (!message.filePath) {
            throw new Error("No file path provided");
          }

          // Lưu file trong cùng thư mục với file input
          const outputPath = await saveToFile(translations, message.filePath);
          webviewView.webview.postMessage({
            command: "done",
            outputPath: outputPath,
          });
        } catch (error) {
          console.error("Generation error:", error);
          webviewView.webview.postMessage({
            command: "apiResponse",
            success: false,
            error: error.message,
          });
        }
      } else if (message.command === "openFile") {
        const document = await vscode.workspace.openTextDocument(message.path);
        await vscode.window.showTextDocument(document);
      } else if (message.command === "showError") {
        vscode.window.showErrorMessage(message.message);
      } else if (message.command === "selectFolder") {
        const folderUri = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
        });

        if (folderUri && folderUri[0]) {
          webviewView.webview.postMessage({
            command: "folderSelected",
            path: folderUri[0].fsPath,
          });
        }
      } else if (message.command === "extract") {
        try {
          // Bắt đầu quét folder
          const extractedTexts = await this.extractTextsFromFolder(
            message.folderPath
          );

          // Hiển thị dialog để lưu file
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(
              path.join(message.folderPath, "extracted-texts.txt")
            ),
            filters: {
              "Text Files": ["txt"],
            },
          });

          if (saveUri) {
            // Lưu file
            fs.writeFileSync(saveUri.fsPath, extractedTexts.join("\n"));
            webviewView.webview.postMessage({
              command: "extractComplete",
              outputPath: saveUri.fsPath,
            });
          }
        } catch (error) {
          webviewView.webview.postMessage({
            command: "showError",
            error: error.message,
          });
        }
      }
    });
  }

  extractJsonFromResponse(response) {
    if (!response) {
      console.error("No response data found.");
      return {};
    }

    // Nếu response là object, kiểm tra các trường hợp phổ biến của từng model
    if (typeof response === "object") {
      // Case 1: OpenAI, Claude (kiểm tra response dạng này)
      if (response.choices && response.choices[0]?.message?.content) {
        response = response.choices[0].message.content;
      }
      // Case 2: Qwen (kiểm tra response dạng này)
      else if (response.response) {
        response = response.response;
      }
      // Case 3: Meta AI, hoặc các model khác trả về dạng "text"
      else if (response.text) {
        response = response.text;
      }
      // Case 4: Kiểm tra các trường hợp còn lại có thể tồn tại trong response
      else if (response.data && response.data.choices) {
        response =
          response.data.choices[0]?.message?.content || response.data.text;
      } else {
        console.error("Unknown response format:", response);
        return {}; // Trả về đối tượng JSON trống nếu không tìm thấy dạng chuẩn.
      }
    }

    console.log("Raw response:", response);

    // Tìm kiếm JSON trong response nếu nó nằm trong ba dấu \`\`\`json
    const jsonMatch = response.match(/```json([\s\S]*?)```/);

    // Nếu không có \`\`\`json, kiểm tra nếu có ba dấu \`\`\`
    if (!jsonMatch) {
      const fallbackMatch = response.match(/```([\s\S]*?)```/);
      if (fallbackMatch) {
        return parseJson(fallbackMatch[1]);
      }
    } else {
      return parseJson(jsonMatch[1]);
    }

    return {}; // Trả về đối tượng JSON trống nếu không thể parse

    // Hàm để parse JSON từ chuỗi
    function parseJson(rawJson) {
      const trimmedJson = rawJson.trim();
      try {
        return JSON.parse(trimmedJson);
      } catch (error) {
        console.error("Error parsing JSON:", error.message);
        return {};
      }
    }
  }

  async extractTextsFromFolder(folderPath) {
    const texts = new Set();

    // Đọc tất cả các file trong folder
    const files = await this.getAllFiles(folderPath);

    for (const file of files) {
      // Chỉ xử lý các file có extension phù hợp
      if (
        file.endsWith(".js") ||
        file.endsWith(".jsx") ||
        file.endsWith(".ts") ||
        file.endsWith(".tsx")
      ) {
        const content = fs.readFileSync(file, "utf8");

        // Tìm tất cả các chuỗi trong dấu nháy kép và đơn
        const matches = content.match(
          /"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'/g
        );

        if (matches) {
          matches.forEach((match) => {
            // Loại bỏ dấu nháy và thêm vào Set
            const text = match.slice(1, -1).trim();
            if (text && !this.shouldIgnore(text)) {
              texts.add(text);
            }
          });
        }
      }
    }

    return Array.from(texts);
  }

  shouldIgnore(text) {
    // Bỏ qua các chuỗi không cần thiết
    const ignorePatterns = [
      /^[0-9]+$/, // Chỉ số
      /^https?:\/\//, // URLs
      /^[a-zA-Z0-9]+$/, // Một từ không có khoảng trắng
      /^\s*$/, // Chuỗi trống hoặc chỉ có khoảng trắng
      /^.+@.+\..+$/, // Email
      /^[,.!?;:'"`~]+$/, // Dấu câu
      /^@.+$/,
    ];

    return ignorePatterns.some((pattern) => pattern.test(text));
  }

  async getAllFiles(dirPath, arrayOfFiles = []) {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);

      if (
        stat.isDirectory() &&
        !file.startsWith(".") &&
        file !== "node_modules"
      ) {
        arrayOfFiles = await this.getAllFiles(filePath, arrayOfFiles);
      } else {
        arrayOfFiles.push(filePath);
      }
    }

    return arrayOfFiles;
  }

  getHtml() {
    return `
    <html>
    <head>
        <style>
            :root {
                --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                --primary-color: var(--vscode-button-background);
                --text-color: var(--vscode-foreground);
                --border-color: var(--vscode-input-border);
            }

            body {
                padding: 16px;
                color: var(--text-color);
                font-family: var(--vscode-font-family);
            }

            .container {
                max-width: 100%;
                margin: 0 auto;
            }

            h2 {
                margin-bottom: 20px;
                font-size: 1.2em;
                border-bottom: 1px solid var(--border-color);
                padding-bottom: 10px;
            }

            .form-group {
                margin-bottom: 16px;
            }

            label {
                display: block;
                margin-bottom: 6px;
                font-size: 12px;
                font-weight: 500;
            }

            input, button {
                width: 100%;
                padding: 8px;
                border: 1px solid var(--border-color);
                border-radius: 4px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                margin-bottom: 8px;
            }

            button {
                background: var(--primary-color);
                color: var(--vscode-button-foreground);
                border: none;
                cursor: pointer;
                font-weight: 500;
                transition: opacity 0.2s;
            }

            button:hover {
                opacity: 0.9;
            }

            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .file-info {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                margin-top: 4px;
                word-break: break-all;
            }

            .loader {
                display: none;
                border: 2px solid var(--border-color);
                border-radius: 50%;
                border-top: 2px solid var(--primary-color);
                width: 16px;
                height: 16px;
                animation: spin 1s linear infinite;
                margin: 10px auto;
            }

            .modal {
                display: none;
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: var(--vscode-editor-background);
                padding: 16px;
                border-radius: 4px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
                width: 80%;
                max-width: 300px;
                text-align: center;
            }

            .modal-buttons {
                display: flex;
                gap: 8px;
                margin-top: 16px;
            }

            .modal-buttons button {
                flex: 1;
            }

            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            .section {
                margin-bottom: 32px;
                padding: 16px;
                border: 1px solid var(--border-color);
                border-radius: 4px;
            }
            
            .section-title {
                font-size: 14px;
                font-weight: 600;
                margin-bottom: 16px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>i18n Generator</h2>
            
            <!-- Extract Section -->
            <div class="section">
                <div class="section-title">Extract Texts</div>
                <div class="form-group">
                    <label>Source Folder</label>
                    <button onclick="selectFolder()" id="folderSelectBtn">Choose Folder</button>
                    <div class="file-info" id="selectedFolder">No folder selected</div>
                </div>
                <button onclick="extractTexts()" id="extractBtn">Extract Texts</button>
                <div class="loader" id="extractLoader"></div>
            </div>

            <!-- Generate Section -->
            <div class="section">
                <div class="section-title">Generate Translations</div>
                <div id="form">
                    <div class="form-group">
                        <label>API URL</label>
                        <input type="text" id="apiUrl" value="http://localhost:11434/api/generate" />
                    </div>
                    
                    <div class="form-group">
                        <label>API Key</label>
                        <input type="password" id="apiKey" />
                    </div>
                    
                    <div class="form-group">
                        <label>Languages (comma separated)</label>
                        <input type="text" id="languages" value="en,vi" />
                    </div>
                    
                    <div class="form-group">
                        <label>Input File</label>
                        <button onclick="selectFile()" id="fileSelectBtn">Choose File</button>
                        <div class="file-info" id="selectedFile">No file selected</div>
                    </div>

                    <button onclick="generate()" id="generateBtn">Generate Translations</button>
                    <div class="loader" id="loader"></div>
                </div>
            </div>

            <div id="successModal" class="modal">
                <h3>Success!</h3>
                <p>Translations have been generated successfully.</p>
                <div class="modal-buttons">
                    <button onclick="closeModal()">Close</button>
                    <button onclick="openGeneratedFile()">View File</button>
                </div>
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            const previousState = vscode.getState() || {};
            const form = document.getElementById('form');
            const loader = document.getElementById('loader');
            const modal = document.getElementById('successModal');
            let isGenerating = false;
            let selectedFilePath = '';
            let generatedFilePath = '';
            let fileContent = '';
            let selectedFolderPath = '';

            // Restore previous values
            document.getElementById('apiUrl').value = previousState.apiUrl || 'http://localhost:11434/api/generate';
            document.getElementById('apiKey').value = previousState.apiKey || '';
            document.getElementById('languages').value = previousState.languages || 'en,vi';

            // Save state handlers
            document.getElementById('apiUrl').addEventListener('input', saveState);
            document.getElementById('apiKey').addEventListener('input', saveState);
            document.getElementById('languages').addEventListener('input', saveState);

            function setLoading(isLoading) {
                loader.style.display = isLoading ? 'block' : 'none';
                document.getElementById('generateBtn').disabled = isLoading;
                document.getElementById('fileSelectBtn').disabled = isLoading;
                isGenerating = isLoading;
            }

            function showModal(filePath) {
                generatedFilePath = filePath;
                modal.style.display = 'block';
            }

            function closeModal() {
                modal.style.display = 'none';
            }

            function openGeneratedFile() {
                vscode.postMessage({ command: 'openFile', path: generatedFilePath });
                closeModal();
            }

            function saveState() {
                const state = {
                    apiUrl: document.getElementById('apiUrl').value,
                    apiKey: document.getElementById('apiKey').value,
                    languages: document.getElementById('languages').value
                };
                vscode.setState(state);
            }

            function selectFile() {
                vscode.postMessage({ command: "selectFile" });
            }

            function generate() {
                if (isGenerating) return;
                if (!selectedFilePath) {
                    vscode.postMessage({ 
                        command: 'showError', 
                        message: 'Please select a file first!'
                    });
                    return;
                }

                setLoading(true);
                vscode.postMessage({ 
                    command: "generate", 
                    apiUrl: document.getElementById('apiUrl').value, 
                    apiKey: document.getElementById('apiKey').value, 
                    languages: document.getElementById('languages').value, 
                    sentences: fileContent,
                    filePath: selectedFilePath
                });
            }

            function selectFolder() {
                vscode.postMessage({ command: "selectFolder" });
            }

            function extractTexts() {
                if (!selectedFolderPath) {
                    vscode.postMessage({
                        command: 'showError',
                        message: 'Please select a folder first!'
                    });
                    return;
                }

                document.getElementById('extractLoader').style.display = 'block';
                document.getElementById('extractBtn').disabled = true;
                document.getElementById('folderSelectBtn').disabled = true;

                vscode.postMessage({
                    command: "extract",
                    folderPath: selectedFolderPath
                });
            }

            window.addEventListener('message', event => {
                if (event.data.command === "fileSelected") {
                    selectedFilePath = event.data.path;
                    fileContent = event.data.content;
                    document.getElementById('selectedFile').textContent = selectedFilePath;
                } else if (event.data.command === "done") {
                    setLoading(false);
                    showModal(event.data.outputPath);
                } else if (event.data.command === "apiResponse") {
                    setLoading(false);
                    alert(event.data.success ? "API is working!" : "API failed: " + event.data.error);
                } else if (event.data.command === "folderSelected") {
                    selectedFolderPath = event.data.path;
                    document.getElementById('selectedFolder').textContent = selectedFolderPath;
                } else if (event.data.command === "extractComplete") {
                    document.getElementById('extractLoader').style.display = 'none';
                    document.getElementById('extractBtn').disabled = false;
                    document.getElementById('folderSelectBtn').disabled = false;
                    showModal(event.data.outputPath);
                } else if (event.data.command === "showError") {
                    document.getElementById('extractLoader').style.display = 'none';
                    document.getElementById('extractBtn').disabled = false;
                    document.getElementById('folderSelectBtn').disabled = false;
                    alert(event.data.error);
                }
            });
        </script>
    </body>
    </html>`;
  }
}

async function generateTranslations(data, context) {
  try {
    const prompt = `
  Generate a JSON object with i18n keys for the given sentences, translating them into the following languages: ${data.languages}.  
  The expected JSON format:  

  {
    "eng": {
      "meaningful_key": "English translation",
      ...
    },
    "vie": {
      "meaningful_key": "Vietnamese translation",
      ...
    },
    "de": {
      "meaningful_key": "German translation",
      ...
    }
    ...
  }

  **Requirements:**  
  - The keys must be meaningful, concise, and written in English.  
  - Translate each sentence **accurately**, keeping the original meaning.  
  - **Do not** add, modify, or hallucinate content.  
  - The output must be in the following format:
    - Map the language names (e.g., "English", "Vietnamese", "German") to their respective language codes (e.g., "eng", "vie", "de").
    - Return **only** a valid JSON object with language keys and translations, no explanations or additional text.  
  - The translation for each sentence should be provided in the correct language key.

  **Sentences to translate (each on a new line, enclosed within triple backticks):**  
  \`\`\`
  ${data.sentences}
  \`\`\`  

  **Output the JSON below:**
`;

    const res = await axios.post(
      data.apiUrl,
      {
        model: "meta-llama/Llama-3.3-70B-Instruct",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 58183,
        temperature: 0.1,
        top_p: 0.9,
        stream: false,
      },
      {
        headers: { Authorization: `Bearer ${data.apiKey}` },
      }
    );

    console.log("API res:", res);

    const jsonResponse = context.extractJsonFromResponse(res);
    return jsonResponse;
  } catch (error) {
    console.log("API error:", error.message);
  }
}

function saveToFile(data, filePath) {
  try {
    if (!data || !filePath) {
      throw new Error("Invalid data or file path");
    }

    const dir = path.dirname(filePath);
    const outputFilePath = path.join(dir, "i18n.json");
    fs.writeFileSync(outputFilePath, JSON.stringify(data, null, 2));
    console.log(`File saved to ${outputFilePath}`);
    return outputFilePath;
  } catch (error) {
    console.error("Error saving file:", error);
    throw error;
  }
}

module.exports = I18nSidebarProvider;
