require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ExcelJS = require('exceljs');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(express.json());

const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 }
});

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("❌ Missing API Key! Set GEMINI_API_KEY in .env");
    process.exit(1);
}

const loadExcelData = async (filePathOrBuffer, isBuffer = false) => {
    try {
        const workbook = new ExcelJS.Workbook();
        if (isBuffer) {
            await workbook.xlsx.load(filePathOrBuffer);
        } else {
            await workbook.xlsx.readFile(filePathOrBuffer);
        }
        
        const worksheet = workbook.worksheets[0];
        if (!worksheet) throw new Error('No sheets found in Excel file');
        
        const data = [];
        worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            const rowData = {};
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                const header = worksheet.getRow(1).getCell(colNumber).value;
                rowData[header] = cell.value || '';
            });
            data.push(rowData);
        });
        
        console.log(`📊 Loaded ${data.length} entries from ${isBuffer ? 'buffer' : 'file'}`);
        return data;
    } catch (error) {
        console.error("❌ Error loading Excel:", error.message);
        return [];
    }
};

let studentData = [];
let eligibilityData = [];
let chatSession = null;

let genAI;
try {
    genAI = new GoogleGenerativeAI(apiKey);
} catch (error) {
    console.error("❌ Failed to initialize Google Generative AI:", error.message);
    process.exit(1);
}

const updateChatSession = (students, eligibility) => {
    const zoho2025Data = [
        { "Name of the Student": "ALAGU NAGASH.G", "LinkedIn": "alagunagash" },
        { "Name of the Student": "KESAVAN S", "LinkedIn": "kesavansk7" },
        { "Name of the Student": "PRAVEEN B", "LinkedIn": "praveen-balu-6829b91b5" },
        { "Name of the Student": "SAHANNA B", "LinkedIn": "sahannab" },
        { "Name of the Student": "SHIVRAM U", "LinkedIn": "shivramu" }
    ];

    const combinedStudentData = [...students, ...zoho2025Data];

    const systemInstruction = `
    I am Career Nexus, specializing in placed students and company eligibility criteria for campus placements at NEC. My data includes:
    - Placed Students (data.xlsx): ${JSON.stringify(combinedStudentData, null, 2)}
    - Company Eligibility Criteria (placement_eligibility.xlsx): ${JSON.stringify(eligibility, null, 2)}

    Reply as plain text with aligned formatting using spaces. For structured data (e.g., tables), use headers with separators ("----") sized to match the longest content in each column for perfect alignment. Support any number of columns with proper spacing. For simple responses, use plain text without tables. Display percentage values (e.g., "10th Percentage", "12th Percentage") exactly as they appear in the data (e.g., "0.75" not converted to "75%"), without modification unless specified otherwise. Interpret "Standing Arrears" as "Current Arrears" (the number of subjects currently uncleared). If similar matches exist across both datasets (e.g., same name or company), provide all relevant responses with correct alignment.

    - If the user says "hi", respond with:
      Hello! How can I help you with information about placed students or company eligibility criteria at NEC?
    - If the user asks for a specific name (e.g., "Shivram U"), search Placed Students data and return:
      Name                  Register Number
      --------------------  ----------------
      [name]                [reg number]
      If no register number exists, leave it blank. If no match:
      I don’t have that information.
    - If the user asks for all students placed at a company (e.g., "zoho placed students"):
      Here are the students placed at [company]:
      Name                  Register Number
      --------------------  ----------------
      [name]                [reg number]
      If no register numbers, omit that column. Include zoho2025Data if applicable. If no data:
      I don’t have information for students placed at [company].
    - If the user asks for LinkedIn (e.g., "Keerthana linkedin"):
      Name                  LinkedIn
      --------------------  ------------------------------------
      [name]                https://www.linkedin.com/in/[linkedin-name]
      If "LinkedIn" is empty or matches the name, use lowercase "Name of the Student" with no spaces/special chars. If no match:
      I don’t have that information.
    - If the user asks "LinkedIn for Zoho placed students":
      Here's the LinkedIn information for Zoho placed students:
      Name                  LinkedIn
      --------------------  ------------------------------------
      ALAGU NAGASH.G        https://www.linkedin.com/in/alagunagash
      KESAVAN S             https://www.linkedin.com/in/kesavansk7
      PRAVEEN B             https://www.linkedin.com/in/praveen-balu-6829b91b5
      SAHANNA B             https://www.linkedin.com/in/sahannab
      SHIVRAM U             https://www.linkedin.com/in/shivramu
    - If the user query includes "eligibility criteria" (e.g., "eligibility criteria" or "eligibility criteria for Zoho"):
      Analyze only the Company Eligibility Criteria data (placement_eligibility.xlsx). 
      For "eligibility criteria" without specifics, list all records:
      Eligibility Criteria for Campus Placements:
      Company               10th Percentage    12th Percentage    CGPA    Current Arrears    History of Arrears
      --------------------  -----------------  -----------------  ------  -----------------  -----------------
      [value]               [value as is]      [value as is]      [value] [value]            [value]
      For specific company (e.g., "eligibility criteria for Zoho"), find matching "Company" records:
      Eligibility Criteria for [company]:
      Company               10th Percentage    12th Percentage    CGPA    Current Arrears    History of Arrears
      --------------------  -----------------  -----------------  ------  -----------------  -----------------
      [value]               [value as is]      [value as is]      [value] [value]            [value]
      If no match:
      I don’t have eligibility information for [company].
    - If the user asks for "rounds" (e.g., "mistral rounds"):
      Return a table with the placement rounds for Mistral Solutions, aligned with fixed-width columns:
      Mistral Solutions Placement Rounds:
      Round Number    Description           
      ------------    ---------------------- 
      1               Pre-placement talk    
      2               Online Assessment     
      3               Technical Interview   
      4               HR Interview          
      5               Group Discussion      
      Important Note: This information is extracted from the provided dataset and may not be fully current or reflect all possible variations in their recruitment process. For the most accurate and up-to-date information, please check with NEC's placement cell or contact Mistral directly.
    - If the user asks for "kaar eligibility":
      Return a table with the eligibility criteria for KAAR Technologies as per placement_eligibility.xlsx:
      Eligibility Criteria for KAAR Technologies:
      Company                        10th Percentage    12th Percentage    CGPA    Current Arrears       History of Arrears
      -----------------------------  -----------------  -----------------  ------  --------------------  -----------------
      M/s.KAAR TECHNOLOGIES,CHENNAI    75%                 75%              7.5    No standing arrears     -
    - For unmatched queries:
      I don’t have that information.
    `;

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: systemInstruction,
        });

        return model.startChat({
            generationConfig: {
                temperature: 1,
                topP: 0.95,
                topK: 40,
                maxOutputTokens: 8192,
                responseMimeType: "text/plain",
            },
            history: [
                { role: "user", parts: [{ text: "hi who are you" }] },
                { role: "model", parts: [{ text: "Hello! I'm Career Nexus. How can I help you with information about placed students or company eligibility criteria at NEC?" }] },
            ],
        });
    } catch (error) {
        console.error("❌ Failed to create chat session:", error.message);
        return null;
    }
};

const initializeData = async () => {
    try {
        studentData = await loadExcelData(path.join(__dirname, 'data.xlsx'));
        eligibilityData = await loadExcelData(path.join(__dirname, 'placement_eligibility.xlsx'));
        if (studentData.length > 0 || eligibilityData.length > 0) {
            chatSession = updateChatSession(studentData, eligibilityData);
            if (!chatSession) throw new Error('Chat session initialization failed');
        }
        console.log('✅ Initial data load complete');
    } catch (error) {
        console.error('❌ Initialization error:', error.message);
    }
};

app.post('/upload-excel', upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }

    try {
        const fileBuffer = await fs.readFile(req.file.path);
        const newData = await loadExcelData(fileBuffer, true);
        
        if (req.file.originalname.toLowerCase().includes('eligibility')) {
            eligibilityData = newData;
        } else {
            studentData = newData;
        }
        
        chatSession = updateChatSession(studentData, eligibilityData);
        if (!chatSession) throw new Error('Failed to update chat session');
        
        await fs.unlink(req.file.path);
        res.json({ message: "Excel file processed successfully" });
    } catch (error) {
        console.error("❌ Upload error:", error.message);
        try {
            await fs.unlink(req.file.path);
        } catch (cleanupError) {
            console.error("❌ Cleanup error:", cleanupError.message);
        }
        res.status(500).json({ error: "Failed to process Excel file" });
    }
});

app.post('/ask', async (req, res) => {
    if (!req.body?.input) {
        return res.status(400).json({ error: "Invalid input" });
    }

    try {
        if (!chatSession) {
            chatSession = updateChatSession(studentData, eligibilityData);
            if (!chatSession) throw new Error("Chat session not initialized");
        }
        
        const result = await chatSession.sendMessage(req.body.input);
        const responseText = result.response?.text() || "No response from AI";
        res.json({ response: responseText });
    } catch (error) {
        console.error("❌ Ask endpoint error:", error.message);
        res.status(500).json({ error: "Server error. Please try again." });
    }
});

const startServer = async () => {
    await initializeData();
    app.listen(port, () => {
        console.log(`🚀 Server running at http://localhost:${port}`);
    });
};

startServer().catch(error => {
    console.error('❌ Server startup failed:', error.message);
    process.exit(1);
});