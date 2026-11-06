// ============================================================
// NAZ - NORTHERN AUTOMOBILE ZONE
// COMPLETE BACKEND SERVER WITH TOLERANT OCR & SAFE DB SAVING
// ============================================================
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const nodemailer = require("nodemailer");
const db = require("./db");
const multer = require("multer");
const fs = require("fs");
// OCR removed in favor of Admin manual verification

const emailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Verify Gmail sender configuration
emailTransporter.verify((error) => {
    if (error) {
        console.error("Email configuration error:", error.message);
    } else {
        console.log("Gmail sender configured successfully.");
    }
});
const app = express();
const PORT = process.env.PORT || 5000;

// ============================================================
// CORS: Allow all local origins (Live Server, React, localhost)
// ============================================================
app.use(cors());

// ============================================================
// BODY PARSER
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// UPLOAD FOLDER SETUP
// ============================================================
const uploadFolder = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadFolder)) {
    fs.mkdirSync(uploadFolder, { recursive: true });
}

// Ensure required rental booking columns exist
function ensureRentalColumn(columnName, columnDefinition) {
    db.query(
        `SHOW COLUMNS FROM rental_bookings LIKE '${columnName}'`,
        (err, cols) => {
            if (err) {
                console.error(`Checking ${columnName} column failed:`, err);
                return;
            }

            if (cols.length === 0) {
                db.query(
                    `ALTER TABLE rental_bookings ADD COLUMN ${columnName} ${columnDefinition}`,
                    (alterErr) => {
                        if (alterErr) {
                            console.error(`Adding ${columnName} failed:`, alterErr);
                        } else {
                            console.log(`${columnName} column added successfully.`);
                        }
                    }
                );
            }
        }
    );
}

ensureRentalColumn("payment_proof", "VARCHAR(255) NULL");
ensureRentalColumn("confirmation_token_hash", "VARCHAR(255) NULL");
ensureRentalColumn("confirmation_expires_at", "DATETIME NULL");
ensureRentalColumn("confirmation_clicked_at", "DATETIME NULL");
ensureRentalColumn("request_id", "VARCHAR(50) NULL");

// Ensure required buy request columns exist
function ensureBuyColumn(columnName, columnDefinition) {
    db.query(
        `SHOW COLUMNS FROM buy_requests LIKE '${columnName}'`,
        (err, cols) => {
            if (err) return;
            if (!cols || cols.length === 0) {
                db.query(`ALTER TABLE buy_requests ADD COLUMN ${columnName} ${columnDefinition}`, (alterErr) => {
                    if (alterErr) console.error(`Adding ${columnName} to buy_requests failed:`, alterErr);
                    else console.log(`${columnName} column added to buy_requests successfully.`);
                });
            }
        }
    );
}
ensureBuyColumn("seller_response", "VARCHAR(50) NULL");
ensureBuyColumn("seller_token_hash", "VARCHAR(255) NULL");
ensureBuyColumn("seller_token_expiry", "DATETIME NULL");
ensureBuyColumn("buyer_payment_token_hash", "VARCHAR(255) NULL");
ensureBuyColumn("buyer_payment_token_expiry", "DATETIME NULL");
// ============================================================
// AUTOMATIC RENTAL BOOKING CONFIRMATION EXPIRY
// ============================================================

function expireUnconfirmedRentalBookings() {

    const query = `
        UPDATE rental_bookings
        SET booking_status = 'Cancelled',
            payment_status = 'Expired',
            confirmation_token_hash = NULL
        WHERE booking_status = 'Awaiting Customer Payment'
          AND confirmation_clicked_at IS NULL
          AND confirmation_expires_at IS NOT NULL
          AND confirmation_expires_at <= NOW()
    `;

    db.query(query, (err, result) => {
        if (err) {
            console.error("Rental booking expiry check failed:", err);
            return;
        }

        if (result.affectedRows > 0) {
            console.log(
                `${result.affectedRows} unconfirmed rental booking(s) automatically cancelled.`
            );
        }
    });
}

// Check every minute, even when no customer visits the website
setInterval(expireUnconfirmedRentalBookings, 60 * 1000);

// Also check expired bookings whenever the server starts
setTimeout(expireUnconfirmedRentalBookings, 5000);
// ============================================================
// MULTER STORAGE CONFIGURATION
// ============================================================
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadFolder);
    },
    filename: function (req, file, cb) {
        const extension = path.extname(file.originalname);
        const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9) + extension;
        cb(null, uniqueName);
    }
});

const fileFilter = function (req, file, cb) {
    const allowedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "application/pdf"
    ];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error("Only JPG, JPEG, PNG, WEBP and PDF files are allowed."));
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// Serve uploaded files statically
app.use("/uploads", express.static(uploadFolder));
app.use(express.static(path.join(__dirname, "..")));

// ============================================================
// HELPER: SAFE FILE DELETION
// ============================================================
function deleteFile(filePath) {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (e) {
        console.error("File deletion error:", e.message);
    }
}

function deleteUploadedFiles(filesObject) {
    if (!filesObject) return;
    Object.keys(filesObject).forEach(fieldName => {
        const fileList = filesObject[fieldName];
        if (Array.isArray(fileList)) {
            fileList.forEach(f => deleteFile(f.path));
        }
    });
}

// OCR helpers removed - vehicle documents and details are audited directly by Admin in Admin Panel.
// ============================================================
// SELLER / BUYER / RENTAL SIGNUP & LOGIN APIs
// ============================================================


// ============================================================
// SELLER SIGNUP
// ============================================================

app.post("/api/seller/signup", (req, res) => {

    const {
        full_name,
        email,
        phone,
        password,
        confirmPassword
    } = req.body;

    // Required fields check
    if (!full_name || !email || !phone || !password || !confirmPassword) {
        return res.status(400).json({
            success: false,
            message: "Please fill all required fields."
        });
    }

    // Gmail validation
    const gmailPattern = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

    if (!gmailPattern.test(email)) {
        return res.status(400).json({
            success: false,
            message: "Please enter a valid Gmail address."
        });
    }

    // Phone validation
    if (!/^03[0-9]{9}$/.test(phone)) {
        return res.status(400).json({
            success: false,
            message: "Phone number must be exactly 11 digits and start with 03."
        });
    }

    // Password validation
    if (password.length < 5) {
        return res.status(400).json({
            success: false,
            message: "Password must contain at least 5 characters."
        });
    }

    // Confirm password
    if (password !== confirmPassword) {
        return res.status(400).json({
            success: false,
            message: "Passwords do not match."
        });
    }

    // Check duplicate email or phone
    const checkQuery = `
        SELECT id
        FROM seller_users
        WHERE email = ? OR phone = ?
    `;

    db.query(checkQuery, [email, phone], (err, results) => {

        if (err) {
            console.log("Seller signup check error:", err);

            return res.status(500).json({
                success: false,
                message: "Database error."
            });
        }

        if (results.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Email or phone number is already registered."
            });
        }

        // Plain text password as requested
        const insertQuery = `
            INSERT INTO seller_users
            (full_name, email, phone, password)
            VALUES (?, ?, ?, ?)
        `;

        db.query(
            insertQuery,
            [full_name, email, phone, password],
            (err, result) => {

                if (err) {
                    console.log("Seller signup error:", err);

                    return res.status(500).json({
                        success: false,
                        message: "Unable to create seller account."
                    });
                }

                res.status(201).json({
                    success: true,
                    message: "Seller account created successfully.",
                    user: {
                        id: result.insertId,
                        full_name: full_name,
                        email: email,
                        phone: phone,
                        userType: "seller"
                    }
                });
            }
        );
    });
});


// ============================================================
// SELLER LOGIN
// ============================================================

app.post("/api/seller/login", (req, res) => {

    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Please enter email and password."
        });
    }

    const query = `
        SELECT id, full_name, email, phone, password
        FROM seller_users
        WHERE email = ?
    `;

    db.query(query, [email], (err, results) => {

        if (err) {
            console.log("Seller login error:", err);

            return res.status(500).json({
                success: false,
                message: "Database error."
            });
        }

        if (results.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        const user = results[0];

        if (user.password !== password) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        res.json({
            success: true,
            message: "Seller login successful.",
            user: {
                id: user.id,
                full_name: user.full_name,
                email: user.email,
                phone: user.phone,
                userType: "seller"
            }
        });
    });
});


// ============================================================
// BUYER SIGNUP
// ============================================================

app.post("/api/buyer/signup", (req, res) => {

    const {
        full_name,
        email,
        phone,
        password,
        confirmPassword
    } = req.body;

    if (!full_name || !email || !phone || !password || !confirmPassword) {
        return res.status(400).json({
            success: false,
            message: "Please fill all required fields."
        });
    }

    const gmailPattern = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

    if (!gmailPattern.test(email)) {
        return res.status(400).json({
            success: false,
            message: "Please enter a valid Gmail address."
        });
    }

    if (!/^03[0-9]{9}$/.test(phone)) {
        return res.status(400).json({
            success: false,
            message: "Phone number must be exactly 11 digits and start with 03."
        });
    }

    if (password.length < 5) {
        return res.status(400).json({
            success: false,
            message: "Password must contain at least 5 characters."
        });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({
            success: false,
            message: "Passwords do not match."
        });
    }

    const checkQuery = `
        SELECT id
        FROM buyer_users
        WHERE email = ? OR phone = ?
    `;

    db.query(checkQuery, [email, phone], (err, results) => {

        if (err) {
            console.log("Buyer signup check error:", err);

            return res.status(500).json({
                success: false,
                message: "Database error."
            });
        }

        if (results.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Email or phone number is already registered."
            });
        }

        const insertQuery = `
            INSERT INTO buyer_users
            (full_name, email, phone, password)
            VALUES (?, ?, ?, ?)
        `;

        db.query(
            insertQuery,
            [full_name, email, phone, password],
            (err, result) => {

                if (err) {
                    console.log("Buyer signup error:", err);

                    return res.status(500).json({
                        success: false,
                        message: "Unable to create buyer account."
                    });
                }

                res.status(201).json({
                    success: true,
                    message: "Buyer account created successfully.",
                    user: {
                        id: result.insertId,
                        full_name: full_name,
                        email: email,
                        phone: phone,
                        userType: "buyer"
                    }
                });
            }
        );
    });
});


// ============================================================
// BUYER LOGIN
// ============================================================

app.post("/api/buyer/login", (req, res) => {

    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Please enter email and password."
        });
    }

    const query = `
        SELECT id, full_name, email, phone, password
        FROM buyer_users
        WHERE email = ?
    `;

    db.query(query, [email], (err, results) => {

        if (err) {
            console.log("Buyer login error:", err);

            return res.status(500).json({
                success: false,
                message: "Database error."
            });
        }

        if (results.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        const user = results[0];

        if (user.password !== password) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        res.json({
            success: true,
            message: "Buyer login successful.",
            user: {
                id: user.id,
                full_name: user.full_name,
                email: user.email,
                phone: user.phone,
                userType: "buyer"
            }
        });
    });
});


// ============================================================
// RENTAL SIGNUP
// ============================================================

app.post("/api/rental/signup", (req, res) => {

    const {
        full_name,
        email,
        phone,
        password,
        confirmPassword
    } = req.body;

    if (!full_name || !email || !phone || !password || !confirmPassword) {
        return res.status(400).json({
            success: false,
            message: "Please fill all required fields."
        });
    }

    const gmailPattern = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

    if (!gmailPattern.test(email)) {
        return res.status(400).json({
            success: false,
            message: "Please enter a valid Gmail address."
        });
    }

    if (!/^03[0-9]{9}$/.test(phone)) {
        return res.status(400).json({
            success: false,
            message: "Phone number must be exactly 11 digits and start with 03."
        });
    }

    if (password.length < 5) {
        return res.status(400).json({
            success: false,
            message: "Password must contain at least 5 characters."
        });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({
            success: false,
            message: "Passwords do not match."
        });
    }

    const checkQuery = `
        SELECT id
        FROM rental_users
        WHERE email = ? OR phone = ?
    `;

    db.query(checkQuery, [email, phone], (err, results) => {

        if (err) {
            console.log("Rental signup check error:", err);

            return res.status(500).json({
                success: false,
                message: "Database error."
            });
        }

        if (results.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Email or phone number is already registered."
            });
        }

        const insertQuery = `
            INSERT INTO rental_users
            (full_name, email, phone, password)
            VALUES (?, ?, ?, ?)
        `;

        db.query(
            insertQuery,
            [full_name, email, phone, password],
            (err, result) => {

                if (err) {
                    console.log("Rental signup error:", err);

                    return res.status(500).json({
                        success: false,
                        message: "Unable to create rental account."
                    });
                }

                res.status(201).json({
                    success: true,
                    message: "Rental account created successfully.",
                    user: {
                        id: result.insertId,
                        full_name: full_name,
                        email: email,
                        phone: phone,
                        userType: "rental"
                    }
                });
            }
        );
    });
});


// ============================================================
// RENTAL LOGIN
// ============================================================

app.post("/api/rental/login", (req, res) => {

    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Please enter email and password."
        });
    }

    const query = `
        SELECT id, full_name, email, phone, password
        FROM rental_users
        WHERE email = ?
    `;

    db.query(query, [email], (err, results) => {

        if (err) {
            console.log("Rental login error:", err);

            return res.status(500).json({
                success: false,
                message: "Database error."
            });
        }

        if (results.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        const user = results[0];

        if (user.password !== password) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        res.json({
            success: true,
            message: "Rental login successful.",
            user: {
                id: user.id,
                full_name: user.full_name,
                email: user.email,
                phone: user.phone,
                userType: "rental"
            }
        });
    });
});
// ============================================================
// TEST ENDPOINTS
// ============================================================
app.get("/", (req, res) => {
    res.send("NAZ Backend is Running Successfully!");
});

app.get("/test-db", (req, res) => {
    db.query("SELECT 1 AS test", (err) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Database connection failed: " + err.message);
        }
        res.send("Database connected successfully!");
    });
});

//api/vehicles
app.get("/api/vehicles", (req, res) => {
    const statusFilter = req.query.status;

    let query = `
        SELECT *
        FROM vehicles
        WHERE status = 'Approved'
          AND (sale_status IN ('Available', 'Reserved') OR sale_status IS NULL)
        ORDER BY id DESC
    `;

    let params = [];

    // Admin: show all vehicles, including Reserved, Removed and Sold
    if (statusFilter === "all") {
        query = `
            SELECT *
            FROM vehicles
            ORDER BY id DESC
        `;
    } else if (statusFilter) {
        query = `
            SELECT *
            FROM vehicles
            WHERE status = ?
            ORDER BY id DESC
        `;
        params = [statusFilter];
    }

    db.query(query, params, (err, results) => {
        if (err) {
            console.error("Get vehicles error:", err);
            return res.status(500).json({
                message: "Could not fetch vehicles."
            });
        }

        res.json(results);
    });
});

// ============================================================
// SOLD VEHICLES API
// ============================================================

app.get("/api/sold-vehicles", (req, res) => {

    const query = `
        SELECT *
        FROM vehicles
        WHERE status = 'Approved'
          AND sale_status = 'Sold'
        ORDER BY id DESC
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error("Get sold vehicles error:", err);
            return res.status(500).json({
                success: false,
                message: "Could not fetch sold vehicles."
            });
        }
        res.json(results);
    });
});

// ============================================================
// VEHICLE API - POST (OCR + DOCUMENTS + DB INSERTION)
// ============================================================
app.post(
    "/api/vehicles",
    upload.fields([
        { name: "sellerIdCard", maxCount: 1 },
        { name: "customsDocument", maxCount: 1 },
        { name: "ncpDocument", maxCount: 1 },
        { name: "bikeDocument", maxCount: 1 },
        { name: "vehicleImages", maxCount: 6 }
    ]),
    async (req, res) => {
        console.log("\n==========================================");
        console.log("New Vehicle Submission Received");
        console.log("==========================================");

        const files = req.files || {};
        const body = req.body;

        try {
            // 1. Seller Information
            const seller_name = (body.seller_name || "").trim();
            const seller_email = (body.seller_email || "").trim();
            const seller_phone = (body.seller_phone || "").trim();
            const seller_location = (body.seller_location || "").trim();
            const seller_address = (body.seller_address || "").trim();

            if (!seller_name || !seller_email || !seller_phone || !seller_location || !seller_address) {
                deleteUploadedFiles(files);
                return res.status(400).json({ message: "Please fill all seller information." });
            }

            const sellerIdCard = files.sellerIdCard ? files.sellerIdCard[0] : null;
            if (!sellerIdCard) {
                deleteUploadedFiles(files);
                return res.status(400).json({ message: "Seller CNIC / ID Card image is required." });
            }

            // 2. Vehicle Information
            const vehicle_type = (body.vehicle_type || "").trim();
            const registration_type = body.registration_type ? body.registration_type.trim() : null;
            const brand = (body.brand || "").trim();
            const model = (body.model || "").trim();
            const manufacturing_year = parseInt(body.manufacturing_year, 10) || null;
            const engine_cc = parseInt(body.engine_cc, 10) || null;
            const mileage = parseInt(body.mileage, 10) || 0;
            const asking_price = parseFloat(body.asking_price) || 0;

            const chassis_number = (body.chassis_number || "").trim() || null;
            const engine_number = (body.engine_number || "").trim() || null;
            const vehicle_condition = (body.vehicle_condition || "Good").trim();
            const fuel_type = (body.fuel_type || "Petrol").trim();
            const transmission = (body.transmission || "Automatic").trim();
            const registration_number = (body.registration_number || "").trim() || null;
            const vehicle_make_model_year = (body.vehicle_make_model_year || "").trim() || null;
            const customs_paid_status = (body.customs_paid_status || "").trim() || null;
            const vehicle_description = (body.vehicle_description || "").trim() || null;

            const vehicleImages = files.vehicleImages || [];
            if (vehicleImages.length < 1) {
                deleteUploadedFiles(files);
                return res.status(400).json({ message: "Please upload at least one vehicle image." });
            }

            // ==================================================
            // DIRECT DOCUMENT VALIDATION (NO OCR - ADMIN AUDIT)
            // ==================================================
            if (vehicle_type === "Car" && registration_type === "Custom Paid") {
                const customsDocument = files.customsDocument ? files.customsDocument[0] : null;
                if (!customsDocument) {
                    deleteUploadedFiles(files);
                    return res.status(400).json({ message: "Custom Paid registration document is required." });
                }
            }

            if (vehicle_type === "Car" && registration_type === "NCP") {
                const ncpDocument = files.ncpDocument ? files.ncpDocument[0] : null;
                if (!ncpDocument) {
                    deleteUploadedFiles(files);
                    return res.status(400).json({ message: "NCP vehicle document is required." });
                }
            }

            if (vehicle_type === "Motorcycle") {
                const bikeDocument = files.bikeDocument ? files.bikeDocument[0] : null;
                if (!bikeDocument) {
                    deleteUploadedFiles(files);
                    return res.status(400).json({ message: "Motorcycle registration document is required." });
                }
            }

            // ==================================================
            // PATH GENERATION FOR DATABASE
            // ==================================================
            const sellerIdCardPath = "/uploads/" + sellerIdCard.filename;
            let registrationDocumentPath = null;
            let bikeDocumentPath = null;

            if (vehicle_type === "Car") {
                if (registration_type === "Custom Paid" && files.customsDocument) {
                    registrationDocumentPath = "/uploads/" + files.customsDocument[0].filename;
                } else if (registration_type === "NCP" && files.ncpDocument) {
                    registrationDocumentPath = "/uploads/" + files.ncpDocument[0].filename;
                }
            }

            if (vehicle_type === "Motorcycle" && files.bikeDocument) {
                bikeDocumentPath = "/uploads/" + files.bikeDocument[0].filename;
            }

            const vehicleImagePaths = vehicleImages.map(img => "/uploads/" + img.filename);
            const vehicleImagesJSON = JSON.stringify(vehicleImagePaths);

            // ==================================================
            // INSERT INTO VEHICLES DATABASE
            // ==================================================
            const insertQuery = `
                INSERT INTO vehicles (
                    seller_name,
                    seller_email,
                    seller_phone,
                    seller_location,
                    seller_address,
                    seller_id_card,

                    vehicle_type,
                    registration_type,

                    brand,
                    model,
                    manufacturing_year,
                    engine_cc,
                    mileage,
                    asking_price,

                    chassis_number,
                    engine_number,
                    vehicle_condition,

                    fuel_type,
                    transmission,

                    registration_number,
                    vehicle_make_model_year,
                    customs_paid_status,
                    vehicle_description,

                    registration_document,
                    bike_document,

                    vehicle_images,
                    verification_status,
                    status
                )
                VALUES (
                    ?, ?, ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, ?,
                    ?,
                    'Pending',
                    'Pending'
                )
            `;

            const values = [
                seller_name,
                seller_email,
                seller_phone,
                seller_location,
                seller_address,
                sellerIdCardPath,

                vehicle_type,
                registration_type,

                brand,
                model,
                manufacturing_year,
                engine_cc,
                mileage,
                asking_price,

                chassis_number,
                engine_number,
                vehicle_condition,

                fuel_type,
                transmission,

                registration_number,
                vehicle_make_model_year,
                customs_paid_status,
                vehicle_description,

                registrationDocumentPath,
                bikeDocumentPath,

                vehicleImagesJSON
            ];

            db.query(insertQuery, values, (err, result) => {
                if (err) {
                    console.error("❌ Vehicle database insert error:", err);
                    deleteUploadedFiles(files);
                    return res.status(500).json({
                        message: "Database insertion error: " + (err.sqlMessage || err.message)
                    });
                }

                console.log("==========================================");
                console.log("✅ Vehicle Successfully Saved to DB with Pending Status!");
                console.log("Vehicle ID:", result.insertId);
                console.log("Status: Pending Admin Approval");
                console.log("==========================================\n");

                return res.status(201).json({
                    success: true,
                    message: "Aap ki sell vehicle successfully submit ho chuki hai aur abhi Admin verification ke liye Pending me hai. Admin tasdeeq ke baad buy page par 'Verified' badge ke sath list karega.",
                    vehicleId: result.insertId,
                    status: "Pending",
                    verification: "Pending Admin Verification"
                });
            });

        } catch (error) {
            console.error("❌ Vehicle submission unexpected error:", error);
            deleteUploadedFiles(files);
            return res.status(500).json({
                message: error.message || "Vehicle submission failed."
            });
        }
    }
);


// ============================================================
// RENTAL VEHICLE APIs
// ============================================================

// GET ALL RENTAL VEHICLES
app.get("/api/rental-vehicles", (req, res) => {
    const query = `
        SELECT 
            id,
            vehicle_type,
            brand,
            model,
            manufacturing_year,
            fuel_type,
            transmission,
            location,
            rent_per_day,
            DATE_FORMAT(available_from, '%Y-%m-%d') AS available_from,
            DATE_FORMAT(available_until, '%Y-%m-%d') AS available_until,
            image_path,
            description,
            owner_name,
            owner_phone,
            owner_email,
            created_at
        FROM rental_vehicles
        ORDER BY id DESC
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error("Rental vehicles fetch error:", err);
            return res.status(500).json({
                message: "Could not fetch rental vehicles."
            });
        }

        res.json(results);
    });
});


// ADD VEHICLE FOR RENT
app.post(
    "/api/rental-vehicles",
    upload.array("vehicleImages", 6),
    (req, res) => {

        console.log("\n==========================================");
        console.log("New Rental Vehicle Submission");
        console.log("==========================================");

        const body = req.body;
        const files = req.files || [];

        const vehicleType =
            (body.vehicleType || "").trim();

        const brand =
            (body.brand || "").trim();

        const model =
            (body.model || "").trim();

        const vehicleYear =
            parseInt(body.vehicleYear, 10) || null;

        const fuelType =
            (body.fuelType || "").trim();

        const transmission =
            (body.transmission || "").trim();

        const location =
            (body.location || "").trim();

        const rentPerDay =
            parseFloat(body.rentPerDay) || 0;

        const availableFrom =
            (body.availableFrom || "").trim();

        const availableUntil =
            (body.availableUntil || "").trim();

        const ownerName =
            (body.ownerName || "Vehicle Owner").trim();

        const ownerPhone =
            (body.ownerPhone || "0345-9876543").trim();

        const ownerEmail =
            (body.ownerEmail || "owner@naz-rental.pk").trim();


        // ======================================
        // REQUIRED FIELD CHECK
        // ======================================

        if (
            !vehicleType ||
            !brand ||
            !model ||
            !vehicleYear ||
            !location ||
            !rentPerDay ||
            !availableFrom ||
            !availableUntil
        ) {

            deleteUploadedFiles({
                vehicleImages: files
            });

            return res.status(400).json({
                message: "Please fill all required fields."
            });
        }


        // ======================================
        // IMAGE CHECK
        // ======================================

        if (files.length === 0) {

            return res.status(400).json({
                message: "Please upload at least one vehicle image."
            });
        }


        // ======================================
        // DATE CHECK
        // ======================================

        const today = new Date();
const todayStr =
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        if (
              availableFrom < todayStr ||
               availableUntil < availableFrom
                ) {
             deleteUploadedFiles({
              vehicleImages: files
             });

            return res.status(400).json({
           message:
                 "Available From cannot be in the past, and Available Until must be on or after Available From."
             });
            }


        // ======================================
        // IMAGE PATHS
        // ======================================

        const imagePaths =
            files.map(file => "/uploads/" + file.filename);

        const imagePathJSON =
            JSON.stringify(imagePaths);


        // ======================================
        // INSERT INTO RENTAL VEHICLES
        // ======================================

        const insertQuery = `
            INSERT INTO rental_vehicles (
                vehicle_type,
                brand,
                model,
                manufacturing_year,
                fuel_type,
                transmission,
                location,
                rent_per_day,
                available_from,
                available_until,
                image_path,
                owner_name,
                owner_phone,
                owner_email
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;


        const values = [
            vehicleType,
            brand,
            model,
            vehicleYear,
            fuelType,
            transmission,
            location,
            rentPerDay,
            availableFrom,
            availableUntil,
            imagePathJSON,
            ownerName,
            ownerPhone,
            ownerEmail
        ];


        db.query(
            insertQuery,
            values,
            (err, result) => {

                if (err) {

                    console.error(
                        "Rental vehicle database error:",
                        err
                    );

                    deleteUploadedFiles({
                        vehicleImages: files
                    });

                    return res.status(500).json({
                        message:
                            "Database insertion error: " +
                            (err.sqlMessage || err.message)
                    });
                }


                console.log(
                    "Rental vehicle successfully saved!"
                );

                console.log(
                    "Rental Vehicle ID:",
                    result.insertId
                );


                return res.status(201).json({

                    success: true,

                    message:
                        "Vehicle added for rent successfully!",

                    vehicleId:
                        result.insertId

                });
            }
        );
    }
);
// ============================================================
// RENTAL BOOKING API
// ============================================================
app.post("/api/rental-bookings", (req, res) => {
    const {
        vehicle_id,
        customer_name,
        customer_email,
        customer_phone,
        pickup_date,
        return_date
    } = req.body;
    // REQUIRED FIELD CHECK
    if (
        !vehicle_id ||
        !customer_name ||
        !customer_email ||
        !customer_phone ||
        !pickup_date ||
        !return_date
    ) {
        return res.status(400).json({
            message: "Please fill all required booking fields."
        });
    }
    // DATE CHECK
    if (return_date < pickup_date) {
        return res.status(400).json({
            message: "Return date cannot be before pickup date."
        });
    }
    // GET VEHICLE DETAILS
    const vehicleQuery = `
        SELECT
            id,
            brand,
            model,
            manufacturing_year,
            location,
            rent_per_day,
            available_from,
            available_until
        FROM rental_vehicles
        WHERE id = ?
    `;

    db.query(
        vehicleQuery,
        [vehicle_id],
        (err, vehicleResults) => {
            if (err) {
                console.error("Vehicle booking lookup error:", err);
                return res.status(500).json({
                    message: "Could not check vehicle details."
                });
            }
            // VEHICLE NOT FOUND
            if (vehicleResults.length === 0) {
                return res.status(404).json({
                    message: "Vehicle not found."
                });
            }
            const vehicle = vehicleResults[0];
            // CHECK VEHICLE AVAILABLE DATES
            if (
                pickup_date < vehicle.available_from ||
                return_date > vehicle.available_until
            ) {
                return res.status(400).json({
                    message:
                        "Selected dates are outside the vehicle's available rental period."
                });
            }
            // CALCULATE TOTAL DAYS (INCLUSIVE)
            const pickup = new Date(pickup_date + "T00:00:00");
            const returnDate = new Date(return_date + "T00:00:00");

            const difference =
                returnDate.getTime() - pickup.getTime();

            const totalDays =
                Math.ceil(
                    difference / (1000 * 60 * 60 * 24)
                ) + 1;

            if (totalDays <= 0) {
                return res.status(400).json({
                    message: "Invalid rental dates."
                });
            }

            // CALCULATE TOTAL AMOUNT
            const rentPerDay = Number(vehicle.rent_per_day);
            const totalAmount = totalDays * rentPerDay;
            const nazFee = totalAmount * 0.10;

            // CHECK EXISTING BOOKINGS
            // These statuses keep the selected dates reserved.
            const bookingCheckQuery = `
                SELECT id
                FROM rental_bookings
                WHERE vehicle_id = ?
                AND booking_status IN (
                    'Pending',
                    'Awaiting Customer Payment',
                    'Pending Admin Review',
                    'Confirmed'
                )
                AND pickup_date <= ?
                AND return_date >= ?
            `;

            db.query(
                bookingCheckQuery,
                [
                    vehicle_id,
                    return_date,
                    pickup_date
                ],
                (bookingErr, bookingResults) => {

                    if (bookingErr) {
                        console.error(
                            "Booking availability error:",
                            bookingErr
                        );

                        return res.status(500).json({
                            message:
                                "Could not check vehicle availability."
                        });
                    }

                    // VEHICLE ALREADY BOOKED
                    if (bookingResults.length > 0) {
                        return res.status(409).json({
                            message:
                                "This vehicle is already booked for the selected dates."
                        });
                    }

                    // INSERT BOOKING
                    const insertQuery = `
                        INSERT INTO rental_bookings (
                            vehicle_id,
                            customer_name,
                            customer_email,
                            customer_phone,
                            pickup_date,
                            return_date,
                            total_days,
                            rent_per_day,
                            total_amount,
                            naz_fee,
                            booking_status
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
                    `;

                    const values = [
                        vehicle_id,
                        customer_name.trim(),
                        customer_email.trim(),
                        customer_phone.trim(),
                        pickup_date,
                        return_date,
                        totalDays,
                        rentPerDay,
                        totalAmount,
                        nazFee
                    ];

                    db.query(
                        insertQuery,
                        values,
                        (insertErr, result) => {

                            if (insertErr) {
                                console.error(
                                    "Booking database error:",
                                    insertErr
                                );

                                return res.status(500).json({
                                    message:
                                        "Booking could not be saved."
                                });
                            }

                            // SUCCESS RESPONSE
                            console.log(
                                "Rental booking successfully saved!"
                            );

                            console.log(
                                "Booking ID:",
                                result.insertId
                            );

                            return res.status(201).json({
                                success: true,

                                message:
                                    "Booking request submitted successfully!",

                                bookingId: result.insertId,
                                vehicleId: vehicle_id,

                                vehicle:
                                    vehicle.brand + " " + vehicle.model,

                                pickupDate: pickup_date,
                                returnDate: return_date,
                                totalDays: totalDays,
                                rentPerDay: rentPerDay,
                                totalAmount: totalAmount,
                                nazFee: nazFee,
                                bookingStatus: "Pending"
                            });
                        }
                    );
                }
            );
        }
    );
});

// ============================================================
// HELPER: CALCULATE VEHICLE BOOKED DATES & AVAILABILITY
// ============================================================

// ============================================================
// HELPER: CALCULATE VEHICLE BOOKED DATES & AVAILABILITY
// ============================================================
function getVehicleAvailabilityData(vehicleId, callback) {

    const vehicleQuery = `
        SELECT 
            id, 
            brand, 
            model, 
            manufacturing_year, 
            rent_per_day, 
            DATE_FORMAT(available_from, '%Y-%m-%d') AS available_from, 
            DATE_FORMAT(available_until, '%Y-%m-%d') AS available_until, 
            location
        FROM rental_vehicles
        WHERE id = ?
    `;

    db.query(vehicleQuery, [vehicleId], (vErr, vResults) => {

        if (vErr || !vResults || vResults.length === 0) {
            return callback(
                vErr || new Error("Vehicle not found"),
                null
            );
        }

        const vehicle = vResults[0];
        const vFromStr = vehicle.available_from;
        const vUntilStr = vehicle.available_until;

        // Fetch all active bookings
        const bookingsQuery = `
            SELECT 
                id, 
                DATE_FORMAT(pickup_date, '%Y-%m-%d') AS pickup_date, 
                DATE_FORMAT(return_date, '%Y-%m-%d') AS return_date, 
                booking_status
            FROM rental_bookings
            WHERE vehicle_id = ?
            AND booking_status IN (
                'Pending',
                'Awaiting Customer Payment',
                'Pending Admin Review',
                'Confirmed'
            )
            ORDER BY pickup_date ASC
        `;

        db.query(bookingsQuery, [vehicleId], (bErr, bResults) => {

            if (bErr) {
                return callback(bErr, null);
            }

            const formatDateStr = (d) => {
                if (!d) return "";

                const dt = new Date(d);

                const year = dt.getFullYear();
                const month = String(dt.getMonth() + 1).padStart(2, "0");
                const day = String(dt.getDate()).padStart(2, "0");

                return `${year}-${month}-${day}`;
            };

            const bookedRanges = (bResults || []).map(b => ({
                id: b.id,
                pickup: b.pickup_date,
                return: b.return_date
            }));

            // Collect all individual booked days
            const bookedDates = [];

            bookedRanges.forEach(range => {

                let cur = new Date(range.pickup + "T00:00:00");
                const end = new Date(range.return + "T00:00:00");

                while (cur <= end) {

                    const ymd = formatDateStr(cur);

                    if (!bookedDates.includes(ymd)) {
                        bookedDates.push(ymd);
                    }

                    cur.setDate(cur.getDate() + 1);
                }
            });

            // Calculate free days within available range starting today
            const todayStr = formatDateStr(new Date());

            const effStartStr =
                vFromStr < todayStr ? todayStr : vFromStr;

            let totalDays = 0;
            let freeDays = 0;

            if (effStartStr <= vUntilStr) {

                let cur = new Date(effStartStr + "T00:00:00");
                const end = new Date(vUntilStr + "T00:00:00");

                while (cur <= end) {

                    totalDays++;

                    const ymd = formatDateStr(cur);

                    if (!bookedDates.includes(ymd)) {
                        freeDays++;
                    }

                    cur.setDate(cur.getDate() + 1);
                }
            }

            // Check whether vehicle is fully booked
            const isFullyBooked =
                (totalDays > 0 && freeDays <= 0) ||
                (totalDays === 0);

            callback(null, {

                vehicle: {
                    id: vehicle.id,
                    brand: vehicle.brand,
                    model: vehicle.model,
                    year: vehicle.manufacturing_year,
                    rentPerDay: vehicle.rent_per_day,
                    location: vehicle.location,
                    availableFrom: vFromStr,
                    availableUntil: vUntilStr
                },

                availableFrom: vFromStr,
                availableUntil: vUntilStr,

                bookedRanges,
                bookedDates,
                totalDays,
                freeDays,
                isFullyBooked
            });
        });
    });
}


// 1. VEHICLE AVAILABILITY & BOOKED DATES API
app.get("/api/rental-vehicles/:vehicleId/availability", (req, res) => {
    getVehicleAvailabilityData(req.params.vehicleId, (err, data) => {
        if (err) {
            return res.status(404).json({ success: false, message: err.message || "Could not check availability." });
        }
        res.json({ success: true, ...data });
    });
});

// 2. CHECK VEHICLE BOOKING STATUS (UPDATED: Checks if truly fully booked)
app.get("/api/rental-bookings/check/:vehicleId", (req, res) => {
    getVehicleAvailabilityData(req.params.vehicleId, (err, data) => {
        if (err) {
            return res.status(500).json({ success: false, message: "Could not check vehicle status." });
        }
        res.json({
            success: true,
            booked: data.isFullyBooked,
            freeDays: data.freeDays,
            bookedRanges: data.bookedRanges
        });
    });
});


// ============================================================
// UPLOAD PAYMENT PROOF / SCREENSHOT API
// ============================================================
app.post("/api/rental-bookings/upload-proof", upload.single("paymentProof"), (req, res) => {

    const bookingId = req.body.booking_id;
    const paymentMethod = req.body.payment_method || "Online Payment";
    const file = req.file;

    if (!bookingId) {
        if (file) deleteFile(file.path);

        return res.status(400).json({
            success: false,
            message: "Booking ID is required."
        });
    }

    if (!file) {
        return res.status(400).json({
            success: false,
            message: "Please upload a payment screenshot."
        });
    }

    // CHECK BOOKING AND CONFIRMATION
    const checkQuery = `
        SELECT
             id, booking_status, (confirmation_expires_at > NOW()) AS deadline_valid
        FROM rental_bookings
        WHERE id = ?
    `;
    db.query(checkQuery, [bookingId], (checkErr, results) => {
        if (checkErr) {
            console.error("Booking verification error:", checkErr);
            deleteFile(file.path);
            return res.status(500).json({
                success: false,
                message: "Could not verify booking."
            });
        }

        if (!results || results.length === 0) {
            deleteFile(file.path);

            return res.status(404).json({
                success: false,
                message: "Booking not found."
            });
        }

        const booking = results[0];

        // CONFIRMATION LINK MUST BE CLICKED FIRST
        if (
    booking.booking_status !== "Awaiting Customer Payment" ||
    !booking.deadline_valid
)  {
    return res.status(403).json({
        success: false,
        message: "Booking has expired or is not eligible for payment."
    });
}

        const imagePath = "/uploads/" + file.filename;
        const transactionId = "NAZ-" + Date.now();

        // SAVE PAYMENT PROOF
        const query = `
            UPDATE rental_bookings
            SET payment_proof = ?,
                payment_method = ?,
                payment_status = 'Pending Verification',
                transaction_id = ?,
                payment_date = CURRENT_TIMESTAMP,
                booking_status = 'Pending Admin Review'
            WHERE id = ?
            AND booking_status = 'Awaiting Customer Payment'
            AND confirmation_clicked_at IS NOT NULL
        `;

        db.query(
            query,
            [imagePath, paymentMethod, transactionId, bookingId],
            (err, result) => {

                if (err) {
                    console.error("Payment proof DB error:", err);
                    deleteFile(file.path);

                    return res.status(500).json({
                        success: false,
                        message: "Could not save payment proof."
                    });
                }

                if (result.affectedRows === 0) {
                    deleteFile(file.path);

                    return res.status(409).json({
                        success: false,
                        message: "Booking is no longer eligible for payment proof submission."
                    });
                }

                console.log(
                    `Payment proof uploaded for Booking #${bookingId}: ${imagePath}`
                );

                return res.status(200).json({
                    success: true,

                    message:
                        "Your payment proof has been submitted successfully. Your request is now under Admin review. Your booking ID will be sent to your email after approval.",

                    bookingId: Number(bookingId),
                    transactionId: transactionId,
                    paymentProof: imagePath,
                    paymentStatus: "Pending Verification",
                    bookingStatus: "Pending Admin Review"
                });
            }
        );
    });
});

//-----------------
//POST RENTAL API
//-----------------
app.post("/api/rental-bookings/payment", (req, res) => {

    const { booking_id, payment_method } = req.body;

    // REQUIRED FIELD CHECK
    if (!booking_id || !payment_method) {
        return res.status(400).json({
            success: false,
            message: "Booking ID and payment method are required."
        });
    }

    // GET BOOKING DETAILS
    const bookingQuery = `
        SELECT
             b.*,
            (b.confirmation_expires_at > NOW()) AS deadline_valid,
            v.brand,
            v.model,
            v.manufacturing_year
        FROM rental_bookings b
        LEFT JOIN rental_vehicles v ON b.vehicle_id = v.id
        WHERE b.id = ?
    `;

    db.query(bookingQuery, [booking_id], (err, results) => {

        if (err) {
            console.error("Rental payment booking lookup error:", err);

            return res.status(500).json({
                success: false,
                message: "Could not retrieve booking details."
            });
        }

        if (!results || results.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking not found."
            });
        }

        const booking = results[0];

        // CONFIRMATION LINK MUST BE CLICKED FIRST
        if (
            booking.booking_status !== "Awaiting Customer Payment" ||
            !booking.confirmation_clicked_at
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "Please confirm your booking using the confirmation link sent to your email first."
            });
        }

        // GENERATE TRANSACTION ID
        const transactionId = "NAZ-" + Date.now();

        // UPDATE PAYMENT METHOD
        // Keep booking status unchanged.
        const updateQuery = `
            UPDATE rental_bookings
            SET payment_method = ?,
                transaction_id = ?,
                payment_status = 'Awaiting Proof'
            WHERE id = ?
            AND booking_status = 'Awaiting Customer Payment'
            AND confirmation_clicked_at IS NOT NULL
        `;

        db.query(
            updateQuery,
            [payment_method, transactionId, booking_id],
            (uErr, updateResult) => {

                if (uErr) {
                    console.error("Rental payment update error:", uErr);

                    return res.status(500).json({
                        success: false,
                        message: "Payment receipt could not be generated."
                    });
                }

                if (updateResult.affectedRows === 0) {
                    return res.status(403).json({
                        success: false,
                        message: "Booking is not eligible for payment."
                    });
                }

                
// SEND PAYMENT EMAIL TO CUSTOMER
console.log("Sending rental payment email to:", booking.customer_email);

emailTransporter.sendMail({

    from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,

    to: booking.customer_email,

    subject: "NAZ Rental - Payment Details",

    html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">

            <h2 style="color: #123b70;">NAZ - Northern Automobile Zone</h2>

            <h3>Dear ${booking.customer_name},</h3>

            <p>Your rental payment details have been generated successfully.</p>

            <h3>Booking Details</h3>

            <p>
                <strong>Booking ID:</strong> ${booking_id}<br>
                <strong>Vehicle:</strong> ${booking.brand || ""} ${booking.model || ""}<br>
                <strong>Pickup Date:</strong> ${booking.pickup_date}<br>
                <strong>Return Date:</strong> ${booking.return_date}<br>
                <strong>Total Days:</strong> ${booking.total_days}
            </p>

            <h3>Payment Details</h3>

            <p>
                <strong>Payment Method:</strong> ${payment_method}<br>
                <strong>Transaction ID:</strong> ${transactionId}<br>
                <strong>Total Rental Amount:</strong> PKR ${Number(booking.total_amount).toLocaleString()}<br>
                <strong>NAZ Service Fee (10%):</strong> PKR ${Number(booking.naz_fee).toLocaleString()}
            </p>

            <p>
                Please complete your payment using the payment account details
                displayed on the NAZ website.
            </p>

            <p>
                After payment, upload your payment screenshot on the website
                for Admin verification.
            </p>

            <p>Thank you for choosing NAZ!</p>

            <strong>NAZ - Northern Automobile Zone</strong>

        </div>
    `

}).then((info) => {

    console.log("Rental payment email sent successfully.");
    console.log("Email Message ID:", info.messageId);

    return res.status(200).json({

        success: true,
        emailSent: true,

        message: "Payment email successfully sent to customer.",

        bookingId: booking_id,
        transactionId: transactionId,
        paymentMethod: payment_method,
        paymentStatus: "Awaiting Proof",
        bookingStatus: "Awaiting Customer Payment",

        customerName: booking.customer_name,
        customerEmail: booking.customer_email,

        vehicleName: `${booking.brand || ""} ${booking.model || ""}`,

        pickupDate: booking.pickup_date,
        returnDate: booking.return_date,
        totalDays: booking.total_days,
        totalAmount: Number(booking.total_amount),
        nazFee: Number(booking.naz_fee)

    });

}).catch((emailError) => {

    console.error("Rental payment email failed:", emailError);

    return res.status(500).json({

        success: false,
        emailSent: false,

        message: "Payment method was saved, but email could not be sent. Please try again."

    });

});

            }
        );
    });
});

app.get("/api/rental-bookings/payment-access/:id", (req, res) => {

    const bookingId = req.params.id;

    const query = `
        SELECT
            b.id,
            b.customer_name,
            b.customer_email,
            b.booking_status,
            b.pickup_date,
            b.return_date,
            b.total_days,
            b.total_amount,
            b.naz_fee,
            (b.confirmation_expires_at > NOW()) AS deadline_valid,
            v.brand,
            v.model,
            v.manufacturing_year
        FROM rental_bookings b
        LEFT JOIN rental_vehicles v ON b.vehicle_id = v.id
        WHERE b.id = ?
    `;

    db.query(query, [bookingId], (err, results) => {

        if (err) {
            console.error("Payment access check error:", err);
            return res.status(500).json({
                success: false,
                message: "Could not verify booking."
            });
        }

        if (!results || results.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking not found."
            });
        }

        const booking = results[0];

        if (
            booking.booking_status !== "Awaiting Customer Payment" ||
            !booking.deadline_valid
        ) {
            return res.status(403).json({
                success: false,
                message: "Booking has expired or is not eligible for payment."
            });
        }

        // MARK THAT CUSTOMER OPENED THE PAYMENT LINK
        const markAccessQuery = `
            UPDATE rental_bookings
            SET confirmation_clicked_at = COALESCE(confirmation_clicked_at, NOW())
            WHERE id = ?
              AND booking_status = 'Awaiting Customer Payment'
              AND confirmation_expires_at > NOW()
        `;

        db.query(markAccessQuery, [bookingId], (updateErr, updateResult) => {

            if (updateErr) {
                console.error("Payment access update error:", updateErr);
                return res.status(500).json({
                    success: false,
                    message: "Could not verify payment access."
                });
            }

            if (updateResult.affectedRows === 0) {
                return res.status(403).json({
                    success: false,
                    message: "Booking is not eligible for payment."
                });
            }

            return res.json({
                success: true,
                booking: {
                    bookingId: booking.id,
                    customerName: booking.customer_name,
                    customerEmail: booking.customer_email,
                    vehicle:
                        `${booking.brand || ""} ${booking.model || ""} (${booking.manufacturing_year || ""})`,
                    pickupDate: booking.pickup_date,
                    returnDate: booking.return_date,
                    totalDays: booking.total_days,
                    totalAmount: Number(booking.total_amount),
                    nazFee: Number(booking.naz_fee)
                }
            });
        });
    });
});
// GET SINGLE RENTAL BOOKING WITH CONDITIONAL OWNER CONTACT
app.get("/api/rental-bookings/:id", (req, res) => {
    const bookingId = req.params.id;
    const query = `
        SELECT 
            b.*,
            DATE_FORMAT(b.pickup_date, '%Y-%m-%d') AS pickup_date_formatted,
            DATE_FORMAT(b.return_date, '%Y-%m-%d') AS return_date_formatted,
            v.brand,
            v.model,
            v.manufacturing_year,
            v.location AS vehicle_location,
            v.rent_per_day,
            v.owner_name,
            v.owner_phone,
            v.owner_email
        FROM rental_bookings b
        LEFT JOIN rental_vehicles v ON b.vehicle_id = v.id
        WHERE b.id = ?
    `;

    db.query(query, [bookingId], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.status(404).json({ success: false, message: "Booking not found." });
        }

        const b = results[0];
        const isApproved = (b.booking_status === "Confirmed" || b.payment_status === "Paid");

        res.json({
            success: true,
            booking: {
                id: b.id,
                vehicleId: b.vehicle_id,
                vehicleName: `${b.brand || ''} ${b.model || ''} (${b.manufacturing_year || ''})`,
                customerName: b.customer_name,
                customerEmail: b.customer_email,
                customerPhone: b.customer_phone,
                pickupDate: b.pickup_date_formatted || b.pickup_date,
                returnDate: b.return_date_formatted || b.return_date,
                totalDays: b.total_days,
                totalAmount: Number(b.total_amount),
                nazFee: Number(b.naz_fee),
                bookingStatus: b.booking_status,
                paymentStatus: b.payment_status,
                paymentMethod: b.payment_method,
                transactionId: b.transaction_id,
                paymentProof: b.payment_proof,
                ownerContactRevealed: isApproved,
                ownerName: isApproved ? b.owner_name : null,
                ownerPhone: isApproved ? b.owner_phone : null,
                ownerEmail: isApproved ? b.owner_email : null,
                ownerNotice: isApproved 
                    ? "Payment verified! You can now contact the vehicle owner directly." 
                    : "Vehicle owner contact details will be revealed once Admin approves your payment screenshot."
            }
        });
    });
});

// TRACK RENTAL BOOKINGS (BY PHONE, EMAIL OR ID)
app.get("/api/rental-bookings/track/search", (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) {
        return res.status(400).json({ success: false, message: "Please provide a Booking ID, Phone, or Email." });
    }

    const query = `
        SELECT 
            b.*,
            DATE_FORMAT(b.pickup_date, '%Y-%m-%d') AS pickup_date_formatted,
            DATE_FORMAT(b.return_date, '%Y-%m-%d') AS return_date_formatted,
            v.brand,
            v.model,
            v.manufacturing_year,
            v.location AS vehicle_location,
            v.owner_name,
            v.owner_phone,
            v.owner_email
        FROM rental_bookings b
        LEFT JOIN rental_vehicles v ON b.vehicle_id = v.id
        WHERE b.id = ? OR b.customer_phone = ? OR b.customer_email = ?
        ORDER BY b.id DESC
    `;

    db.query(query, [q, q, q], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: "Database search error." });
        }

        const mapped = (results || []).map(b => {
            const isApproved = (b.booking_status === "Confirmed" || b.payment_status === "Paid");
            return {
                id: b.id,
                vehicleName: `${b.brand || ''} ${b.model || ''}`,
                customerName: b.customer_name,
                customerPhone: b.customer_phone,
                pickupDate: b.pickup_date_formatted,
                returnDate: b.return_date_formatted,
                totalAmount: Number(b.total_amount),
                nazFee: Number(b.naz_fee),
                bookingStatus: b.booking_status,
                paymentStatus: b.payment_status,
                ownerContactRevealed: isApproved,
                ownerName: isApproved ? b.owner_name : null,
                ownerPhone: isApproved ? b.owner_phone : null,
                ownerEmail: isApproved ? b.owner_email : null
            };
        });

        res.json({ success: true, bookings: mapped });
    });
});

// ============================================================
// BUY VEHICLE (10% NAZ FEE) APIs
// ============================================================

// NEW: CREATE BUY REQUEST WITHOUT PAYMENT (WITH ATOMIC RESERVATION)
app.post("/api/buy/request", (req, res) => {
    const { vehicle_id, buyer_name, buyer_email, buyer_phone } = req.body;

    if (!vehicle_id || !buyer_name?.trim() ||
        !buyer_email?.trim() || !buyer_phone?.trim()) {
        return res.status(400).json({
            success: false,
            message: "Please provide all buyer details."
        });
    }

    const email = buyer_email.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({
            success: false,
            message: "Please enter a valid email address."
        });
    }

    db.query(
        "SELECT * FROM vehicles WHERE id = ?",
        [vehicle_id],
        (err, vehicles) => {
            if (err) {
                console.error("Vehicle lookup error:", err);
                return res.status(500).json({
                    success: false,
                    message: "Could not check vehicle."
                });
            }

            if (!vehicles || vehicles.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Vehicle not found."
                });
            }

            const vehicle = vehicles[0];

            if (vehicle.status !== "Approved") {
                return res.status(400).json({
                    success: false,
                    message: "This vehicle is not verified for purchase."
                });
            }

            if ((vehicle.sale_status || "Available") !== "Available") {
                return res.status(409).json({
                    success: false,
                    message: "This vehicle is currently reserved by another buyer or unavailable."
                });
            }

            // ATOMIC RESERVATION: update vehicle sale_status = 'Reserved' immediately
            const reserveQuery = `
                UPDATE vehicles
                SET sale_status = 'Reserved'
                WHERE id = ?
                  AND status = 'Approved'
                  AND (sale_status = 'Available' OR sale_status IS NULL)
            `;

            db.query(reserveQuery, [vehicle_id], (resErr, resResult) => {
                if (resErr) {
                    console.error("Atomic reservation error:", resErr);
                    return res.status(500).json({
                        success: false,
                        message: "Could not reserve vehicle."
                    });
                }

                if (resResult.affectedRows === 0) {
                    return res.status(409).json({
                        success: false,
                        message: "This vehicle is currently reserved by another buyer or unavailable."
                    });
                }

                const vehiclePrice = Number(vehicle.asking_price) || 0;
                const nazFee = Math.round(vehiclePrice * 0.10);

                const insertQuery = `
                    INSERT INTO buy_requests (
                        vehicle_id,
                        buyer_name,
                        buyer_email,
                        buyer_phone,
                        vehicle_price,
                        naz_fee,
                        status
                    )
                    VALUES (?, ?, ?, ?, ?, ?, 'Pending Seller Confirmation')
                `;

                const values = [
                    vehicle_id,
                    buyer_name.trim(),
                    email,
                    buyer_phone.trim(),
                    vehiclePrice,
                    nazFee
                ];

                db.query(insertQuery, values, (insertErr, result) => {
                    if (insertErr) {
                        console.error("Buy request insert error:", insertErr);
                        // Rollback reservation
                        db.query(
                            "UPDATE vehicles SET sale_status = 'Available' WHERE id = ? AND sale_status = 'Reserved'",
                            [vehicle_id]
                        );
                        return res.status(500).json({
                            success: false,
                            message: "Could not submit purchase request."
                        });
                    }

                    return res.status(201).json({
                        success: true,
                        message: "Aap ki purchase request successfully submit ho chuki hai aur vehicle doosre buyers ke liye reserve kar diya gaya hai. Admin seller se tasdeeq karega.",
                        buyRequestId: result.insertId,
                        status: "Pending Seller Confirmation",
                        vehiclePrice,
                        nazFee
                    });
                });
            });
        }
    );
});

// ============================================================
// ADMIN SENDS SELLER AVAILABILITY CONFIRMATION EMAIL
// ============================================================

app.post("/api/admin/buy-requests/:id/send-to-seller", (req, res) => {
    const buyRequestId = req.params.id;

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

    const expiry = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const getQuery = `
        SELECT
            br.id,
            br.status,
            v.brand,
            v.model,
            v.manufacturing_year,
            v.seller_name,
            v.seller_email
        FROM buy_requests br
        JOIN vehicles v ON br.vehicle_id = v.id
        WHERE br.id = ?
    `;

    db.query(getQuery, [buyRequestId], (err, rows) => {
        if (err) {
            console.error("Seller request error:", err);
            return res.status(500).json({
                success: false,
                message: "Could not find buy request."
            });
        }

        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Buy request not found."
            });
        }

        const request = rows[0];

        if (request.status !== "Pending Seller Confirmation") {
            return res.status(400).json({
                success: false,
                message: "This request is not awaiting seller confirmation."
            });
        }

        if (!request.seller_email) {
            return res.status(400).json({
                success: false,
                message: "Seller email is not available."
            });
        }

        const updateQuery = `
            UPDATE buy_requests
            SET seller_token_hash = ?,
                seller_token_expiry = ?,
                status = 'Seller Confirmation Sent'
            WHERE id = ?
        `;

        db.query(
            updateQuery,
            [tokenHash, expiry, buyRequestId],
            (updateErr) => {
                if (updateErr) {
                    console.error("Seller token save error:", updateErr);
                    return res.status(500).json({
                        success: false,
                        message: "Could not prepare seller confirmation."
                    });
                }

                const availableUrl =
                    `http://localhost:5000/api/buy/seller-response?token=${token}&response=Available`;

                const unavailableUrl =
                    `http://localhost:5000/api/buy/seller-response?token=${token}&response=Not%20Available`;

                emailTransporter.sendMail({
                    from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                    to: request.seller_email,
                    subject: "NAZ - Confirm Your Vehicle Availability",
                    html: `
                        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;">
                            <h2 style="color:#123b70;">NAZ - Northern Automobile Zone</h2>

                            <p>Dear ${request.seller_name || "Seller"},</p>

                            <p>A buyer is interested in your vehicle. Please confirm whether it is still available.</p>

                            <h3>${request.brand || ""} ${request.model || ""} ${request.manufacturing_year || ""}</h3>

                            <p>Please select one option:</p>

                            <a href="${availableUrl}"
                               style="display:inline-block;background:#16834a;color:white;padding:13px 25px;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:10px;">
                               ✓ Available
                            </a>

                            <a href="${unavailableUrl}"
                               style="display:inline-block;background:#b83232;color:white;padding:13px 25px;text-decoration:none;border-radius:6px;font-weight:bold;">
                               ✕ Not Available
                            </a>

                            <p style="margin-top:25px;">
                                This confirmation request will expire after 48 hours.
                            </p>

                            <p>Thank you,<br>NAZ Team</p>
                        </div>
                    `
                })
                .then(() => {
                    return res.json({
                        success: true,
                        message: "Seller confirmation email sent successfully.",
                        status: "Seller Confirmation Sent"
                    });
                })
                .catch((emailError) => {
                    console.error("Seller email error:", emailError.message);

                    return res.status(500).json({
                        success: false,
                        message: "Seller email could not be sent."
                    });
                });
            }
        );
    });
});
// ============================================================
// SELLER AVAILABILITY RESPONSE
// ============================================================

app.get("/api/buy/seller-response", (req, res) => {
    const { token, response } = req.query;

    if (!token || !["Available", "Not Available"].includes(response)) {
        return res.status(400).send("Invalid seller response link.");
    }

    const tokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

    const findQuery = `
        SELECT id, vehicle_id, seller_token_expiry
        FROM buy_requests
        WHERE seller_token_hash = ?
          AND status = 'Seller Confirmation Sent'
        LIMIT 1
    `;

    db.query(findQuery, [tokenHash], (err, rows) => {
        if (err) {
            console.error("Seller response lookup error:", err);
            return res.status(500).send("Server error. Please try again.");
        }

        if (!rows || rows.length === 0) {
            return res.status(400).send(
                "This response link is invalid or has already been used."
            );
        }

        const request = rows[0];

        if (
            !request.seller_token_expiry ||
            new Date(request.seller_token_expiry) < new Date()
        ) {
            return res.status(410).send(
                "This seller confirmation link has expired."
            );
        }

        const newStatus = response === "Available"
            ? "Available"
            : "Seller Marked Unavailable";

        const updateQuery = `
            UPDATE buy_requests
            SET seller_response = ?,
                status = ?,
                seller_token_hash = NULL,
                seller_token_expiry = NULL
            WHERE id = ?
              AND seller_token_hash = ?
        `;

        db.query(
            updateQuery,
            [response, newStatus, request.id, tokenHash],
            (updateErr, result) => {
                if (updateErr) {
                    console.error("Seller response update error:", updateErr);
                    return res.status(500).send("Could not save your response.");
                }

                if (result.affectedRows === 0) {
                    return res.status(400).send(
                        "This response link has already been used."
                    );
                }

                if (response === "Available") {
                    db.query(
                        `UPDATE vehicles SET sale_status = 'Reserved' WHERE id = ?`,
                        [request.vehicle_id],
                        (vehicleErr) => {
                            if (vehicleErr) {
                                console.error("Vehicle reservation error:", vehicleErr);
                            }

                            return res.send(`
                                <div style="font-family:Arial,sans-serif;max-width:550px;margin:50px auto;padding:30px;border-radius:12px;background:#f0fdf4;border:1.5px solid #86efac;text-align:center;">
                                    <h2 style="color:#166534;margin-top:0;">✓ Availability Confirmed</h2>
                                    <p style="color:#374151;font-size:15px;line-height:1.6;">
                                        Thank you! You have confirmed that this vehicle is available. NAZ Admin will issue a 10% payment link to the buyer with a 24-hour deadline.
                                    </p>
                                </div>
                            `);
                        }
                    );
                } else {
                    // Seller marked Not Available: remove vehicle from marketplace & email buyer
                    db.query(
                        `UPDATE vehicles SET sale_status = 'Removed' WHERE id = ?`,
                        [request.vehicle_id],
                        (vehicleErr) => {
                            if (vehicleErr) {
                                console.error("Vehicle removal error:", vehicleErr);
                            }

                            // Fetch buyer details to notify them
                            const buyerQuery = `
                                SELECT br.id, br.buyer_name, br.buyer_email, v.brand, v.model, v.manufacturing_year
                                FROM buy_requests br
                                LEFT JOIN vehicles v ON br.vehicle_id = v.id
                                WHERE br.id = ?
                            `;

                            db.query(buyerQuery, [request.id], (bErr, bRows) => {
                                if (!bErr && bRows && bRows.length > 0) {
                                    const bData = bRows[0];
                                    emailTransporter.sendMail({
                                        from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                                        to: bData.buyer_email,
                                        subject: `NAZ Purchase Request - Vehicle Not Available (#${bData.id})`,
                                        html: `
                                            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #e2e8f0;border-radius:10px;">
                                                <h2 style="color:#b91c1c;margin-top:0;">NAZ - Northern Automobile Zone</h2>
                                                <p>Dear <strong>${bData.buyer_name || 'Customer'}</strong>,</p>
                                                <p>We regret to inform you that the seller has indicated that the vehicle is no longer available.</p>
                                                <div style="background:#fef2f2;border:1px solid #fecaca;padding:15px;border-radius:8px;margin:15px 0;">
                                                    <h3 style="margin:0 0 8px;color:#991b1b;">${bData.brand || ''} ${bData.model || ''} (${bData.manufacturing_year || 'N/A'})</h3>
                                                    <p style="margin:0;color:#7f1d1d;font-size:14px;">Status: <strong>Seller Marked Unavailable</strong></p>
                                                </div>
                                                <p style="color:#475569;font-size:14px;line-height:1.6;">
                                                    Your purchase request has been closed and the vehicle has been removed from the Buy Vehicles listing. No fees were charged to you.
                                                </p>
                                                <p style="margin-top:20px;font-size:13px;color:#64748b;">
                                                    Thank you for using NAZ Marketplace. You can explore other verified vehicles on our platform.
                                                </p>
                                            </div>
                                        `
                                    }).catch(e => console.error("Buyer unavailable email error:", e.message));
                                }
                            });

                            return res.send(`
                                <div style="font-family:Arial,sans-serif;max-width:550px;margin:50px auto;padding:30px;border-radius:12px;background:#fef2f2;border:1.5px solid #fecaca;text-align:center;">
                                    <h2 style="color:#b91c1c;margin-top:0;">✕ Vehicle Marked Not Available</h2>
                                    <p style="color:#374151;font-size:15px;line-height:1.6;">
                                        Thank you. The vehicle has been marked as Not Available and removed from NAZ Marketplace. The buyer has been notified.
                                    </p>
                                </div>
                            `);
                        }
                    );
                }
            }
        );
    });
});

// ============================================================
// ADMIN SENDS 10% FEE PAYMENT LINK TO BUYER (24-HOUR DEADLINE)
// ============================================================
app.post("/api/admin/buy-requests/:id/send-payment-link", (req, res) => {
    const buyRequestId = req.params.id;

    const getQuery = `
        SELECT 
            br.id,
            br.vehicle_id,
            br.buyer_name,
            br.buyer_email,
            br.buyer_phone,
            br.vehicle_price,
            br.naz_fee,
            br.status,
            v.brand,
            v.model,
            v.manufacturing_year
        FROM buy_requests br
        LEFT JOIN vehicles v ON br.vehicle_id = v.id
        WHERE br.id = ?
    `;

    db.query(getQuery, [buyRequestId], (err, rows) => {
        if (err) {
            console.error("Payment link request lookup error:", err);
            return res.status(500).json({ success: false, message: "Could not find buy request." });
        }

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Buy request not found." });
        }

        const request = rows[0];

        if (request.status !== "Available" && request.status !== "Awaiting Buyer Payment") {
            return res.status(400).json({
                success: false,
                message: `Payment link can only be sent for requests with 'Awaiting Buyer Payment' status (Current: ${request.status}).`
            });
        }

        if (!request.buyer_email) {
            return res.status(400).json({ success: false, message: "Buyer email is missing." });
        }

        // Generate 24-hour payment token
        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 Hours

        const updateQuery = `
            UPDATE buy_requests
            SET buyer_payment_token_hash = ?,
                buyer_payment_token_expiry = ?,
                status = 'Awaiting Buyer Payment'
            WHERE id = ?
        `;

        db.query(updateQuery, [tokenHash, expiry, buyRequestId], (upErr) => {
            if (upErr) {
                console.error("Save buyer payment token error:", upErr);
                return res.status(500).json({ success: false, message: "Could not prepare payment link." });
            }

            const frontendBase = process.env.FRONTEND_URL || "http://localhost:5000";
            const paymentUrl = `${frontendBase}/buy.html?action=pay&requestId=${request.id}&token=${token}`;

            const vehicleTitle = `${request.brand || ''} ${request.model || ''} (${request.manufacturing_year || 'N/A'})`;
            const nazFeeFormatted = Number(request.naz_fee).toLocaleString();
            const askingPriceFormatted = Number(request.vehicle_price).toLocaleString();

            emailTransporter.sendMail({
                from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                to: request.buyer_email,
                subject: `NAZ Vehicle Purchase - Confirm Your Purchase & Pay 10% Fee (#${request.id})`,
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #e2e8f0;border-radius:12px;">
                        <h2 style="color:#123b70;margin-top:0;">NAZ - Northern Automobile Zone</h2>
                        <p>Dear <strong>${request.buyer_name || 'Customer'}</strong>,</p>
                        
                        <p>The seller has confirmed that your requested vehicle is <strong>Available</strong> for purchase!</p>

                        <div style="background:#f8fafc;padding:16px;border-radius:8px;border:1px solid #e2e8f0;margin:18px 0;">
                            <h3 style="margin:0 0 10px;color:#0f172a;">${vehicleTitle}</h3>
                            <p style="margin:5px 0;font-size:14px;"><strong>Asking Price:</strong> PKR ${askingPriceFormatted}</p>
                            <p style="margin:5px 0;font-size:15px;color:#b00020;"><strong>10% NAZ Token Fee to Pay:</strong> PKR ${nazFeeFormatted}</p>
                        </div>

                        <div style="background:#fffbeb;border:1.5px solid #fde68a;padding:14px;border-radius:8px;margin-bottom:20px;">
                            <p style="margin:0;color:#92400e;font-size:14px;font-weight:bold;">
                                ⏰ 24-Hour Payment Deadline:
                            </p>
                            <p style="margin:6px 0 0;color:#78350f;font-size:13.5px;line-height:1.5;">
                                Please confirm your purchase and submit your payment screenshot within <strong>24 hours</strong>. If screenshot is not submitted within 24 hours, your reservation will be automatically cancelled and the vehicle will become available to others.
                            </p>
                        </div>

                        <div style="text-align:center;margin:30px 0;">
                            <a href="${paymentUrl}"
                               style="display:inline-block;background:#1e40af;color:white;padding:14px 30px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;box-shadow:0 3px 8px rgba(30,64,175,0.3);">
                               ✓ Confirm Your Purchase & Pay 10% Fee
                            </a>
                        </div>

                        <p style="font-size:13px;color:#64748b;line-height:1.5;">
                            You can also open <a href="${frontendBase}/buy.html" style="color:#1e40af;">NAZ Buy Page</a> and click <strong>Track Purchase</strong> using Request ID <strong>#${request.id}</strong> to proceed anytime.
                        </p>

                        <p style="margin-top:25px;font-size:13px;color:#94a3b8;">Thank you,<br>NAZ Management Team</p>
                    </div>
                `
            })
            .then(() => {
                return res.json({
                    success: true,
                    message: `Buyer payment link sent to ${request.buyer_email} successfully with 24-hour deadline.`,
                    buyRequestId: request.id
                });
            })
            .catch((mailErr) => {
                console.error("Buyer payment email error:", mailErr.message);
                return res.status(500).json({
                    success: false,
                    message: "Buyer payment link prepared, but email sending failed. Please verify email credentials."
                });
            });
        });
    });
});

// 1. INITIATE BUY PAYMENT & RECORD PAYMENT METHOD (SECURED FOR EXISTING REQUESTS ONLY)
app.post("/api/buy/payment", (req, res) => {
    const { buy_request_id, payment_method } = req.body;

    if (!buy_request_id || !payment_method) {
        return res.status(400).json({
            success: false,
            message: "Buy Request ID and Payment Method are required."
        });
    }

    const getQuery = `
        SELECT 
            br.*,
            v.brand,
            v.model,
            v.manufacturing_year,
            v.asking_price
        FROM buy_requests br
        LEFT JOIN vehicles v ON br.vehicle_id = v.id
        WHERE br.id = ?
    `;

    db.query(getQuery, [buy_request_id], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Purchase request not found." });
        }

        const request = rows[0];

        // Ensure request is awaiting payment
        const allowedStatuses = ["Available", "Awaiting Buyer Payment", "Awaiting Proof", "Pending Seller Confirmation"];
        if (!allowedStatuses.includes(request.status)) {
            return res.status(400).json({
                success: false,
                message: `Payment cannot be processed for request with status: ${request.status}`
            });
        }

        // Check 24-hour token expiry if applicable
        if (request.buyer_payment_token_expiry && new Date(request.buyer_payment_token_expiry) < new Date()) {
            return res.status(410).json({
                success: false,
                message: "This payment link has expired (24-hour deadline passed). Your request was cancelled."
            });
        }

        const transactionId = "NAZ-BUY-" + Date.now();
        const vehiclePrice = Number(request.vehicle_price || request.asking_price) || 0;
        const nazFee = Number(request.naz_fee) || Math.round(vehiclePrice * 0.10);

        const updateQuery = `
            UPDATE buy_requests
            SET payment_method = ?,
                transaction_id = ?,
                status = 'Awaiting Proof'
            WHERE id = ?
        `;

        db.query(updateQuery, [payment_method, transactionId, buy_request_id], (upErr) => {
            if (upErr) {
                console.error("Payment initiation update error:", upErr);
                return res.status(500).json({ success: false, message: "Could not update payment details." });
            }

            // Send confirmation email to buyer asking for screenshot of this email
            if (request.buyer_email) {
                const frontendBase = process.env.FRONTEND_URL || "http://localhost:5000";
                const vehicleTitle = `${request.brand || ''} ${request.model || ''} (${request.manufacturing_year || 'N/A'})`;
                const nazFeeFormatted = nazFee.toLocaleString();
                emailTransporter.sendMail({
                    from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                    to: request.buyer_email,
                    subject: `NAZ - Aap Ka 10% NAZ Fee Receive Ho Gaya Hai (#${buy_request_id})`,
                    html: `
                        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #e2e8f0;border-radius:12px;">
                            <h2 style="color:#123b70;margin-top:0;">NAZ - Northern Automobile Zone</h2>
                            <p>Dear <strong>${request.buyer_name || 'Customer'}</strong>,</p>
                            
                            <div style="background:#f0fdf4;border:1.5px solid #86efac;padding:16px;border-radius:8px;margin:18px 0;">
                                <h3 style="margin:0 0 8px;color:#166534;"><Your 10% NAZ Service Fee Has Been Received Successfully!/h3>
                                <p style="margin:4px 0;color:#374151;"><strong>Vehicle:</strong> ${vehicleTitle}</p>
                                <p style="margin:4px 0;color:#374151;"><strong>Request ID:</strong> #${buy_request_id}</p>
                                <p style="margin:4px 0;color:#374151;"><strong>Transaction ID:</strong> ${transactionId}</p>
                                <p style="margin:4px 0;color:#374151;"><strong>Payment Method:</strong> ${payment_method}</p>
                                <p style="margin:4px 0;color:#166534;font-size:16px;"><strong>10% NAZ Token Fee:</strong> PKR ${nazFeeFormatted}</p>
                            </div>

                            <div style="background:#fffbeb;border:1.5px solid #fde68a;padding:16px;border-radius:8px;margin:18px 0;">
                                <h4 style="margin:0 0 6px;color:#92400e;">📸 Important Instructions (Required Step):</h4>
                                <p style="margin:0;color:#78350f;font-size:14px;line-height:1.6;">
                                    kindly<strong>take screenshoot of this email</strong> and Submit it on the NAZ website so the Admin can unlock the seller's contact details.
                                </p>
                            </div>

                            <div style="text-align:center;margin:25px 0;">
                                <a href="${frontendBase}/buy.html?action=pay&requestId=${buy_request_id}"
                                   style="display:inline-block;background:#1e40af;color:white;padding:12px 26px;text-decoration:none;border-radius:6px;font-weight:bold;">
                                   📤 Upload Screenshot of This Email
                                </a>
                            </div>

                            <p style="margin-top:20px;font-size:13px;color:#94a3b8;">Thank you,<br>NAZ Management Team</p>
                        </div>
                    `
                }).catch(e => console.error("Buyer fee receipt email err:", e.message));
            }

            return res.json({
                success: true,
                message: "Payment method recorded. Please proceed to upload your payment screenshot.",
                buyRequestId: Number(buy_request_id),
                transactionId: transactionId,
                paymentMethod: payment_method,
                vehicleId: request.vehicle_id,
                vehicleName: `${request.brand || ''} ${request.model || ''} (${request.manufacturing_year || ''})`,
                vehiclePrice: vehiclePrice,
                nazFee: nazFee,
                totalAmount: vehiclePrice + nazFee,
                buyerName: request.buyer_name,
                buyerEmail: request.buyer_email,
                buyerPhone: request.buyer_phone,
                status: request.status
            });
        });
    });
});
// 2. UPLOAD BUY PAYMENT PROOF (SCREENSHOT) WITH STATUS & 24-HOUR DEADLINE VALIDATION
app.post("/api/buy/upload-proof", upload.single("paymentProof"), (req, res) => {
    const buyRequestId = req.body.buy_request_id;
    const file = req.file;
    if (!buyRequestId) {
        if (file) deleteFile(file.path);
        return res.status(400).json({ success: false, message: "Buy Request ID is required." });
    }
    if (!file) {
        return res.status(400).json({ success: false, message: "Please upload payment screenshot." });
    }
    // Verify request status and deadline before accepting proof
    const checkQuery = `
        SELECT 
            br.id,
            br.vehicle_id,
            br.buyer_name,
            br.buyer_email,
            br.buyer_phone,
            br.status,
            br.buyer_payment_token_expiry,
            v.brand,
            v.model
        FROM buy_requests br
        LEFT JOIN vehicles v ON br.vehicle_id = v.id
        WHERE br.id = ?
    `;
    db.query(checkQuery, [buyRequestId], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            deleteFile(file.path);
            return res.status(404).json({ success: false, message: "Buy request not found." });
        }
        const request = rows[0];
        // 1. Check 24-hour deadline
        if (request.buyer_payment_token_expiry && new Date(request.buyer_payment_token_expiry) <= new Date()) {
            deleteFile(file.path);
            // Automatically cancel and release vehicle
            db.query("UPDATE buy_requests SET status = 'Cancelled' WHERE id = ?", [buyRequestId]);
            db.query("UPDATE vehicles SET sale_status = 'Available' WHERE id = ? AND sale_status = 'Reserved'", [request.vehicle_id]);
            return res.status(410).json({
                success: false,
                message: "Payment deadline (24 hours) has expired. Your reservation has been cancelled and the vehicle has been made available again."
            });
        }
        // 2. Allowed statuses for proof upload
        const allowedStatuses = ["Available", "Awaiting Buyer Payment", "Awaiting Proof", "Pending Seller Confirmation"];
        if (!allowedStatuses.includes(request.status)) {
            deleteFile(file.path);
            return res.status(400).json({
                success: false,
                message: `Payment screenshot cannot be uploaded for a request with status: '${request.status}'.`
            });
        }
        const imagePath = "/uploads/" + file.filename;
        const paymentMethod = req.body.payment_method || null;
        const updateQuery = `
            UPDATE buy_requests
            SET payment_proof = ?,
                payment_method = COALESCE(?, payment_method),
                status = 'Pending Verification',
                buyer_payment_token_hash = NULL
            WHERE id = ?
        `;
        db.query(updateQuery, [imagePath, paymentMethod, buyRequestId], (upErr, result) => {
            if (upErr) {
                console.error("Buy proof upload error:", upErr);
                deleteFile(file.path);
                return res.status(500).json({ success: false, message: "Database update error." });
            }
            if (result.affectedRows === 0) {
                deleteFile(file.path);
                return res.status(404).json({ success: false, message: "Buy request could not be updated." });
            }
            // Send notification email to buyer confirming receipt with Request ID
            if (request.buyer_email) {
                emailTransporter.sendMail({
                    from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                    to: request.buyer_email,
                    subject: `NAZ Payment Screenshot Received - Request #${buyRequestId}`,
                    html: `
                        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #e2e8f0;border-radius:10px;">
                            <h2 style="color:#123b70;margin-top:0;">NAZ - Northern Automobile Zone</h2>
                            <p>Dear <strong>${request.buyer_name || 'Customer'}</strong>,</p>
                            <p>Your 10% NAZ fee payment screenshot has been received successfully!</p>
                            <div style="background:#f8fafc;padding:15px;border-radius:8px;border:1px solid #e2e8f0;margin:15px 0;">
                                <p style="margin:5px 0;"><strong>Request ID:</strong> #${buyRequestId}</p>
                                <p style="margin:5px 0;"><strong>Vehicle:</strong> ${request.brand || ''} ${request.model || ''}</p>
                                <p style="margin:5px 0;color:#d97706;"><strong>Status:</strong> Pending Verification (Admin Review)</p>
                            </div>
                            <p style="color:#475569;font-size:14px;line-height:1.6;">
                                Our Admin team is reviewing your payment screenshot. Once approved, the seller's direct contact details and guidance will be unlocked and sent to you.
                            </p>
                            <p style="margin-top:20px;font-size:13px;color:#64748b;">
                                Keep your Request ID (<strong>#${buyRequestId}</strong>) safe to track your request on our website.
                            </p>
                        </div>
                    `
                }).catch(e => console.error("Buyer proof email receipt error:", e.message));
            }
            return res.status(200).json({
                success: true,
                message: "Aap ka payment screenshot Admin ko bhej diya gaya hai! Request ID aap ke email par bhej di gayi hai. Admin tasdeeq ke baad Seller contact unlock karega.",
                buyRequestId: Number(buyRequestId),
                paymentProof: imagePath,
                status: "Pending Verification"
            });
        });
    });
});
// 3. GET SINGLE BUY REQUEST & UNLOCK SELLER CONTACT IF APPROVED
app.get("/api/buy-requests/:id", (req, res) => {
    const requestId = req.params.id;
    const query = `
        SELECT 
            br.*,
            v.brand,
            v.model,
            v.manufacturing_year,
            v.asking_price,
            v.seller_name,
            v.seller_phone,
            v.seller_location,
            v.seller_address
        FROM buy_requests br
        LEFT JOIN vehicles v ON br.vehicle_id = v.id
        WHERE br.id = ?
    `;
    db.query(query, [requestId], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.status(404).json({ success: false, message: "Buy request not found." });
        }
        const r = results[0];
        const isApproved = (r.status === "Approved");
        res.json({
            success: true,
            buyRequest: {
                id: r.id,
                vehicleId: r.vehicle_id,
                vehicleName: `${r.brand || ''} ${r.model || ''} (${r.manufacturing_year || ''})`,
                brand: r.brand,
                model: r.model,
                manufacturingYear: r.manufacturing_year,
                buyerName: r.buyer_name,
                buyerEmail: r.buyer_email,
                buyerPhone: r.buyer_phone,
                vehiclePrice: Number(r.vehicle_price),
                nazFee: Number(r.naz_fee),
                paymentMethod: r.payment_method,
                paymentProof: r.payment_proof,
                status: r.status,
                transactionId: r.transaction_id,
                buyerPaymentDeadline: r.buyer_payment_token_expiry,
                sellerContactUnlocked: isApproved,
                sellerName: isApproved ? r.seller_name : null,
                sellerPhone: isApproved ? r.seller_phone : null,
                sellerLocation: isApproved ? r.seller_location : null,
                sellerAddress: isApproved ? r.seller_address : null,
                message: isApproved 
                    ? "Payment Verified! You now have full access to the seller's contact details."
                    : "Payment verification pending with Admin. Seller contact details will unlock after approval."
            }
        });
    });
});
// 4. TRACK BUY REQUESTS BY PHONE / ID / EMAIL
app.get("/api/buy-requests/track/search", (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) {
        return res.status(400).json({ success: false, message: "Please provide Request ID, Phone, or Email." });
}
    const query = `
        SELECT 
            br.*,
            v.brand,
            v.model,
          v.manufacturing_year,
            v.seller_name,
            v.seller_phone,
            v.seller_location,
            v.seller_address
        FROM buy_requests br
        LEFT JOIN vehicles v ON br.vehicle_id = v.id
        WHERE br.id = ? OR br.buyer_phone = ? OR br.buyer_email = ?
        ORDER BY br.id DESC
    `;
    db.query(query, [q, q, q], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: "Database search error." });
        }
        const mapped = (results || []).map(r => {
            const isApproved = (r.status === "Approved");
            return {
                id: r.id,
                vehicleId: r.vehicle_id,
                vehicleName: `${r.brand || ''} ${r.model || ''} (${r.manufacturing_year || ''})`,
                vehiclePrice: Number(r.vehicle_price),
                nazFee: Number(r.naz_fee),
                buyerName: r.buyer_name,
                buyerEmail: r.buyer_email,
                buyerPhone: r.buyer_phone,
                paymentMethod: r.payment_method,
                paymentProof: r.payment_proof,
                status: r.status,
                buyerPaymentDeadline: r.buyer_payment_token_expiry,
                sellerContactUnlocked: isApproved,
                sellerName: isApproved ? r.seller_name : null,
                sellerPhone: isApproved ? r.seller_phone : null,
                sellerLocation: isApproved ? r.seller_location : null,
                sellerAddress: isApproved ? r.seller_address : null
            };
        });
        res.json({ success: true, requests: mapped });
    });
});
// ============================================================
// ADMIN APIS: COMPREHENSIVE CONTROL
// ============================================================
 // ============================================================
// ADMIN LOGIN & TOKEN AUTHENTICATION
// ============================================================
const adminTokens = new Map();
// Admin login — this route must remain PUBLIC
app.post("/api/admin/login", (req, res) => {
    const { email, password } = req.body;
    if (
        !process.env.ADMIN_EMAIL ||
        !process.env.ADMIN_PASSWORD ||
        email !== process.env.ADMIN_EMAIL ||
        password !== process.env.ADMIN_PASSWORD
    ) {
        return res.status(401).json({
            success: false,
            message: "Invalid admin email or password."
        });
    }
    const token = crypto.randomBytes(32).toString("hex");
    adminTokens.set(token, true);
    return res.json({
        success: true,
        message: "Admin login successful.",
        token: token,
    });
});
// Verify admin token and expiry
function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            message: "Admin authentication required."
        });
    }
    const token = authHeader.slice(7);
    if (!adminTokens.has(token)) {
        return res.status(401).json({
            message: "Invalid admin token. Please login again."
        });
    }
    next();
}
// Protect ALL /api/admin routes.
// The login route above remains public so the admin can sign in.
app.use("/api/admin", requireAdmin);
// 1. Get All Sell Vehicles for Admin
app.get("/api/admin/vehicles", (req, res) => {
    const query = "SELECT * FROM vehicles ORDER BY id DESC";
    db.query(query, (err, results) => {
        if (err) {
            console.error("Admin fetch error:", err);
            return res.status(500).json({ message: "Could not fetch vehicles." });
        }
        res.json(results);
    });
});
// 2. Update Sell Vehicle Status (Approve / Reject)
app.put("/api/admin/vehicles/:id/status", (req, res) => {
    const vehicleId = req.params.id;
    const { status } = req.body;
    if (!status || !["Approved", "Rejected", "Pending"].includes(status)) {
        return res.status(400).json({ message: "Invalid status value." });
    }
    const verStatus = (status === "Approved") ? "Verified" : status;
    const query = "UPDATE vehicles SET status = ?, verification_status = ? WHERE id = ?";
    db.query(query, [status, verStatus, vehicleId], (err, result) => {
        if (err) {
            console.error("Status update error:", err);
            return res.status(500).json({ message: "Could not update status." });
        }
        res.json({
            success: true,
            message: `Vehicle marked as ${status} successfully! ${status === 'Approved' ? 'It is now listed as Verified on Buy Page.' : ''}`
        });
    });
});
// 3. Delete Sell Vehicle
app.delete("/api/admin/vehicles/:id", (req, res) => {
    const vehicleId = req.params.id;
    db.query("SELECT * FROM vehicles WHERE id = ?", [vehicleId], (err, results) => {
        if (results && results.length > 0) {
            const v = results[0];
            if (v.seller_id_card) deleteFile(path.join(__dirname, v.seller_id_card));
            if (v.registration_document) deleteFile(path.join(__dirname, v.registration_document));
            if (v.bike_document) deleteFile(path.join(__dirname, v.bike_document));
        }
        db.query("DELETE FROM vehicles WHERE id = ?", [vehicleId], (delErr) => {
            if (delErr) {
                return res.status(500).json({ message: "Could not delete vehicle." });
            }
            res.json({ success: true, message: "Vehicle deleted successfully." });
        });
    });
});
// 4.Get All Rental Bookings (with Vehicle info and Payment Proof)
app.get("/api/admin/rental-bookings", (req, res) => {
    const query = `
        SELECT 
            b.*,
            DATE_FORMAT(b.pickup_date, '%Y-%m-%d') AS pickup_date_formatted,
            DATE_FORMAT(b.return_date, '%Y-%m-%d') AS return_date_formatted,
            v.brand AS vehicle_brand,
            v.model AS vehicle_model,
            v.manufacturing_year AS vehicle_year,
            v.location AS vehicle_location,
            v.image_path AS vehicle_images,
            v.owner_name,
            v.owner_phone
        FROM rental_bookings b
        LEFT JOIN rental_vehicles v ON b.vehicle_id = v.id
        ORDER BY b.id DESC
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error("Admin rental bookings error:", err);
            return res.status(500).json({ message: "Could not fetch rental bookings." });
        }
        res.json(results);
    });
});
// ============================================================
// 1. ADMIN APPROVES INITIAL RENTAL BOOKING
// Button: Approve & Send Confirmation
// ============================================================
app.put("/api/admin/rental-bookings/:id/approve-booking", (req, res) => {
    const bookingId = req.params.id;
    const bookingQuery = `
        SELECT b.*, v.brand, v.model
        FROM rental_bookings b
        LEFT JOIN rental_vehicles v ON b.vehicle_id = v.id
        WHERE b.id = ?
    `;
    db.query(bookingQuery, [bookingId], (err, results) => {
        if (err) {
            console.error("Booking lookup error:", err);
            return res.status(500).json({
                success: false,
                message: "Could not retrieve booking."
            });
        }
        if (!results.length) {
            return res.status(404).json({
                success: false,
                message: "Rental booking not found."
            });
        }
        const booking = results[0];
        if (booking.booking_status !== "Pending") {
            return res.status(409).json({
                success: false,
                message: "Only Pending bookings can be approved here."
            });
        }
        if (!booking.customer_email) {
            return res.status(400).json({
                success: false,
                message: "Customer email is missing."
            });
        }
        const updateQuery = `
    UPDATE rental_bookings
    SET booking_status = 'Awaiting Customer Payment',
        payment_status = 'Awaiting Customer Confirmation',
        confirmation_token_hash = NULL,
        confirmation_expires_at = DATE_ADD(NOW(), INTERVAL 24 HOUR),
        confirmation_clicked_at = NULL
    WHERE id = ?
      AND booking_status = 'Pending'
`;
        db.query(updateQuery, [bookingId], (updateErr, result) => {
            if (updateErr) {
                console.error("Booking approval error:", updateErr);
                return res.status(500).json({
                    success: false,
                    message: "Could not approve booking."
                });
            }
            if (result.affectedRows === 0) {
                return res.status(409).json({
                    success: false,
                    message: "Booking status has already changed."
                });
            }
            const frontendUrl = (
                process.env.FRONTEND_URL || "http://localhost:5500"
            ).replace(/\/$/, "");
            const confirmationLink =
                 `${frontendUrl}/rent.html?paymentBooking=${bookingId}`;
            emailTransporter.sendMail({
                from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                to: booking.customer_email,
                subject: "NAZ Rental Booking - Confirm Your Booking",
                html: `
                    <h2>Dear ${booking.customer_name},</h2>
                    <p>Your rental booking request has been approved by NAZ Admin.</p>
                    <h3>Booking Details</h3>
                    <p>
                        <strong>Booking ID:</strong> ${bookingId}<br>
                        <strong>Vehicle:</strong> ${booking.brand || ""} ${booking.model || ""}<br>
                        <strong>Pickup Date:</strong> ${booking.pickup_date}<br>
                        <strong>Return Date:</strong> ${booking.return_date}<br>
                        <strong>Total Amount:</strong> PKR ${Number(booking.total_amount)}
                    </p>
                    <p>Please click the button below within <strong>24 hours</strong>
                    to continue to the NAZ payment process.</p>
                    <a href="${confirmationLink}"
                       style="display:inline-block;padding:12px 22px;
                       background-color:#123b70;color:white;
                       text-decoration:none;border-radius:5px;font-weight:bold;">
                        Confirm Booking
                    </a>
                    <p>If you do not click this button within 24 hours,
                    your booking will automatically be cancelled.</p>
                    <p>Thank you for choosing NAZ.</p>
                `
            }).then(() => {
                return res.json({
                    success: true,
                    message: "Booking approved. Confirmation email sent to customer.",
                    bookingStatus: "Awaiting Customer Payment",
                    emailSent: true
                });
            }).catch((emailError) => {
                console.error("Confirmation email failed:", emailError.message);
                return res.json({
                    success: true,
                    message: "Booking approved, but confirmation email could not be sent.",
                    bookingStatus: "Awaiting Customer Payment",
                    emailSent: false
                });
            });
        });
    });
});
// ============================================================
// 2. ADMIN APPROVES PAYMENT SCREENSHOT
// Button: Approve
// ============================================================
app.put("/api/admin/rental-bookings/:id/approve-payment", (req, res) => {
    const bookingId = req.params.id;
    const bookingQuery = `
        SELECT b.*, v.brand, v.model
        FROM rental_bookings b
        LEFT JOIN rental_vehicles v ON b.vehicle_id = v.id
        WHERE b.id = ?
    `;
    db.query(bookingQuery, [bookingId], (err, results) => {
        if (err) {
            console.error("Payment booking lookup error:", err);
            return res.status(500).json({
                success: false,
                message: "Could not retrieve booking."
            });
        }
        if (!results.length) {
            return res.status(404).json({
                success: false,
                message: "Rental booking not found."
            });
        }
        const booking = results[0];
        if (
            booking.booking_status !== "Pending Admin Review" ||
            booking.payment_status !== "Pending Verification"
        ) {
            return res.status(409).json({
                success: false,
                message: "This booking is not awaiting payment verification."
            });
        }
        if (!booking.customer_email) {
            return res.status(400).json({
                success: false,
                message: "Customer email is missing."
            });
        }
const updateQuery = `
    UPDATE rental_bookings
    SET booking_status = 'Confirmed',
        payment_status = 'Paid',
        confirmation_token_hash = NULL
    WHERE id = ?
      AND booking_status = 'Pending Admin Review'
      AND payment_status = 'Pending Verification'
`;
db.query(updateQuery, [bookingId], (updateErr, result) => {
    if (updateErr) {
        console.error("Payment approval error:", updateErr);
        return res.status(500).json({
            success: false,
            message: "Could not approve payment."
        });
    }
    if (result.affectedRows === 0) {
        return res.status(409).json({
            success: false,
            message: "Payment status has already changed."
        });
    }
    emailTransporter.sendMail({
        from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
        to: booking.customer_email,
        subject: "NAZ Rental Booking Confirmed - Your Booking ID",
        html: `
            <h2>Dear ${booking.customer_name},</h2>
            <p>Your payment screenshot has been verified successfully by NAZ Admin.</p>
            <p><strong>Your rental booking is now confirmed!</strong></p>
            <h3>Your Booking ID</h3>
            <p style="font-size:22px;font-weight:bold;color:#123b70;">
                ${bookingId}
            </p>
            <p>Please save this Booking ID. You can use it on the NAZ
            website to track your booking and access the vehicle owner's
            contact details.</p>
            <p>
                <strong>Vehicle:</strong> ${booking.brand || ""} ${booking.model || ""}<br>
                <strong>Pickup Date:</strong> ${booking.pickup_date}<br>
                <strong>Return Date:</strong> ${booking.return_date}
            </p>
            <p>Thank you for choosing NAZ.</p>
        `
    }).then(() => {
        return res.json({
            success: true,
            message: "Payment verified. Booking confirmed and Booking ID emailed.",
            bookingStatus: "Confirmed",
            paymentStatus: "Paid",
            bookingId: Number(bookingId),
            emailSent: true
        });
    }).catch((emailError) => {
        console.error("Booking ID email failed:", emailError.message);
        return res.json({
            success: true,
            message: "Booking confirmed, but Booking ID email could not be sent.",
            bookingStatus: "Confirmed",
            paymentStatus: "Paid",
            bookingId: Number(bookingId),
            emailSent: false
        });
    });
});
    });
});
// ============================================================
// 3. ADMIN REJECTS RENTAL BOOKING OR PAYMENT
// Button: Reject
// ============================================================
app.put("/api/admin/rental-bookings/:id/reject", (req, res) => {
    const bookingId = req.params.id;
    const rejectQuery = `
        UPDATE rental_bookings
        SET booking_status = 'Rejected',
            payment_status = 'Rejected',
            confirmation_token_hash = NULL
        WHERE id = ?
          AND booking_status IN (
              'Pending',
              'Awaiting Customer Payment',
              'Pending Admin Review'
          )
    `;
    db.query(rejectQuery, [bookingId], (err, result) => {
        if (err) {
            console.error("Rental rejection error:", err);
            return res.status(500).json({
                success: false,
                message: "Could not reject rental booking."
            });
        }
        if (result.affectedRows === 0) {
            return res.status(409).json({
                success: false,
                message: "Booking not found or cannot be rejected in its current status."
            });
        }
        return res.json({
            success: true,
            message: `Booking #${bookingId} has been rejected. Its dates are now released.`,
            bookingStatus: "Rejected",
            paymentStatus: "Rejected"
        });
    });
});
// 6. Delete Rental Booking
app.delete("/api/admin/rental-bookings/:id", (req, res) => {
    const bookingId = req.params.id;
    db.query("SELECT payment_proof FROM rental_bookings WHERE id = ?", [bookingId], (err, results) => {
        if (results && results.length > 0 && results[0].payment_proof) {
            deleteFile(path.join(__dirname, results[0].payment_proof));
        }
        db.query("DELETE FROM rental_bookings WHERE id = ?", [bookingId], (delErr) => {
            if (delErr) {
                return res.status(500).json({ message: "Could not delete booking." });
            }
            res.json({ success: true, message: "Rental booking deleted successfully." });
        });
    });
});
// 7. Get All Rental Vehicles for Admin with Booking Counts
app.get("/api/admin/rental-vehicles", (req, res) => {
    const query = `
        SELECT 
            v.*,
            DATE_FORMAT(v.available_from, '%Y-%m-%d') AS available_from_formatted,
            DATE_FORMAT(v.available_until, '%Y-%m-%d') AS available_until_formatted,
            (SELECT COUNT(*) FROM rental_bookings b WHERE b.vehicle_id = v.id AND b.booking_status = 'Confirmed') AS confirmed_count,
            (SELECT COUNT(*) FROM rental_bookings b WHERE b.vehicle_id = v.id AND b.payment_status = 'Pending Verification') AS pending_count
        FROM rental_vehicles v
        ORDER BY v.id DESC
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error("Admin rental vehicles fetch error:", err);
            return res.status(500).json({ message: "Could not fetch rental vehicles." });
        }
        res.json(results);
    });
});
// 8. Delete Rental Vehicle
app.delete("/api/admin/rental-vehicles/:id", (req, res) => {
    const vehicleId = req.params.id;
    db.query("SELECT image_path FROM rental_vehicles WHERE id = ?", [vehicleId], (err, results) => {
        if (results && results.length > 0 && results[0].image_path) {
            try {
                const images = JSON.parse(results[0].image_path);
                if (Array.isArray(images)) {
                    images.forEach(img => deleteFile(path.join(__dirname, img)));
                }
            } catch (e) {}
        }
        db.query("DELETE FROM rental_vehicles WHERE id = ?", [vehicleId], (delErr) => {
            if (delErr) {
                return res.status(500).json({ message: "Could not delete rental vehicle." });
            }
            res.json({ success: true, message: "Rental vehicle deleted successfully." });
        });
    });
});
// 9. ADMIN: GET ALL BUY REQUESTS (10% NAZ FEE)
app.get("/api/admin/buy-requests", (req, res) => {
    const query = `
        SELECT 
            br.*,
            v.brand AS vehicle_brand,
            v.model AS vehicle_model,
            v.manufacturing_year AS vehicle_year,
            v.asking_price AS original_price,
            v.seller_name,
            v.seller_phone,
            v.seller_location,
            v.vehicle_images
        FROM buy_requests br
        LEFT JOIN vehicles v ON br.vehicle_id = v.id
        ORDER BY br.id DESC
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error("Admin buy requests error:", err);
            return res.status(500).json({ message: "Could not fetch buy requests." });
        }
        res.json(results);
    });
});
// 10. ADMIN: UPDATE BUY REQUEST STATUS
app.put("/api/admin/buy-requests/:id/status", (req, res) => {
    const requestId = req.params.id;
    const { status } = req.body;
    if (!status || !["Approved", "Rejected", "Pending Verification"].includes(status)) {
        return res.status(400).json({
            success: false,
            message: "Invalid status value."
        });
    }
    // First, get the buy request details
    const getQuery = `
        SELECT id, vehicle_id, status, payment_proof
        FROM buy_requests
        WHERE id = ?
        LIMIT 1
    `;
    db.query(getQuery, [requestId], (err, rows) => {
        if (err) {
            console.error("Buy request fetch error:", err);
            return res.status(500).json({
                success: false,
                message: "Could not fetch buy request."
            });
        }
        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Buy request not found."
            });
        }
        const request = rows[0];
        // Approval requires payment proof and Pending Verification status
        if (status === "Approved") {
            if (request.status !== "Pending Verification") {
                return res.status(400).json({
                    success: false,
                    message: "Only requests with Pending Verification status can be approved."
                });
            }
            if (!request.payment_proof) {
                return res.status(400).json({
                    success: false,
                    message: "Payment screenshot is required before approval."
                });
            }
            // Mark vehicle as Sold
            const vehicleQuery = `
                UPDATE vehicles
                SET sale_status = 'Sold'
                WHERE id = ?
                  AND sale_status IN ('Available', 'Reserved')
            `;
            db.query(vehicleQuery, [request.vehicle_id], (vehicleErr, vehicleResult) => {
                if (vehicleErr) {
                    console.error("Vehicle sold status error:", vehicleErr);
                    return res.status(500).json({
                        success: false,
                        message: "Could not mark vehicle as Sold."
                    });
                }
                if (vehicleResult.affectedRows === 0) {
                    return res.status(409).json({
                        success: false,
                        message: "Vehicle is already Sold or unavailable."
                    });
                }
                // Approve request and unlock seller contact
                const approveQuery = `
                    UPDATE buy_requests
                    SET status = 'Approved'
                    WHERE id = ?
                      AND status = 'Pending Verification'
                `;
                db.query(approveQuery, [requestId], (approveErr, approveResult) => {
                    if (approveErr || approveResult.affectedRows === 0) {
                        console.error("Buy request approval error:", approveErr);
                        // Restore vehicle status if request approval failed
                        db.query(
                            "UPDATE vehicles SET sale_status = 'Available' WHERE id = ? AND sale_status = 'Sold'",
                            [request.vehicle_id]
                        );
                        return res.status(500).json({
                            success: false,
                            message: "Could not approve buy request."
                        });
                    }
                    // Send approval and tracking guidance email to buyer
                    const buyerQuery = `
                        SELECT br.*, v.brand, v.model, v.manufacturing_year, v.seller_name, v.seller_phone, v.seller_location, v.seller_address
                        FROM buy_requests br
                        LEFT JOIN vehicles v ON br.vehicle_id = v.id
                        WHERE br.id = ?
                    `;
                    db.query(buyerQuery, [requestId], (bErr, bRows) => {
                        if (!bErr && bRows && bRows.length > 0) {
                            const bData = bRows[0];
                            const frontendBase = process.env.FRONTEND_URL || "http://localhost:5000";
                            emailTransporter.sendMail({
                                from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                                to: bData.buyer_email,
                                subject: `NAZ - Owner Contact Info Unlocked! Request #${requestId}`,
                                html: `
                                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #e2e8f0;border-radius:12px;">
                                        <h2 style="color:#166534;margin-top:0;">✓ Payment Screenshot Approved - Owner Contact Unlocked</h2>
                                        <p>Dear <strong>${bData.buyer_name || 'Customer'}</strong>,</p>
                                        <p>Aap ka 10% NAZ fee payment screenshot Admin ne verify aur approve kar diya hai. Owner ki direct contact details unlock ho chuki hain!</p>
                                        <div style="background:#f0fdf4;border:1.5px solid #86efac;padding:18px;border-radius:8px;margin:20px 0;">
                                            <h3 style="margin:0 0 10px;color:#065f46;">👤 Owner Contact Information (Unlocked)</h3>
                                            <p style="margin:6px 0;"><strong>Request ID:</strong> <span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-weight:bold;">#${requestId}</span></p>
                                            <p style="margin:6px 0;"><strong>Vehicle:</strong> ${bData.brand || ''} ${bData.model || ''} (${bData.manufacturing_year || 'N/A'})</p>
                                            <p style="margin:6px 0;"><strong>Asking Price:</strong> PKR ${Number(bData.vehicle_price || 0).toLocaleString()}</p>
                                            <p style="margin:6px 0;"><strong>Owner / Seller Name:</strong> ${bData.seller_name || 'Registered Seller'}</p>
                                            <p style="margin:6px 0;font-size:16px;color:#065f46;"><strong>Owner Phone Number:</strong> 📞 ${bData.seller_phone || 'N/A'}</p>
                                            <p style="margin:6px 0;"><strong>Location:</strong> 📍 ${bData.seller_location || 'Gilgit-Baltistan'}</p>
                                            <p style="margin:6px 0;"><strong>Address:</strong> ${bData.seller_address || 'Contact directly'}</p>
                                        </div>
                                        <div style="background:#eff6ff;border:1.5px solid #bfdbfe;padding:16px;border-radius:8px;margin-bottom:20px;">
                                            <h4 style="margin:0 0 8px;color:#1e40af;">🔑 Kese Request ID ko use kar ke Owner Contact Info Unlock Karein:</h4>
                                            <ol style="margin:0;padding-left:20px;font-size:13.5px;color:#1e3a8a;line-height:1.7;">
                                                <li>NAZ Buy Page par jayein: <a href="${frontendBase}/buy.html" style="color:#2563eb;font-weight:bold;">${frontendBase}/buy.html</a></li>
                                                <li>Top bar par <strong>'Track Purchase / Seller Contact'</strong> button par click karein.</li>
                                                <li>Apna <strong>Request ID (#${requestId})</strong> ya <strong>Phone Number (${bData.buyer_phone || ''})</strong> enter karein aur Check dabayein.</li>
                                                <li>Owner ki details unlock ho kar show hon gi jahan se aap direct call button use kar sakte hain.</li>
                                            </ol>
                                            <div style="text-align:center;margin-top:14px;">
                                                <a href="${frontendBase}/buy.html?action=track&q=${requestId}"
                                                   style="display:inline-block;background:#2563eb;color:white;padding:10px 22px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:13.5px;">
                                                    🔍 View & Unlock Owner Contact on Website
                                                </a>
                                            </div>
                                        </div>
                                        <p style="margin-top:25px;font-size:13px;color:#94a3b8;">Best regards,<br>NAZ Management Team</p>
                                    </div>
                                `
                            }).catch(mailErr => console.error("Buyer approval email error:", mailErr.message));
                        }
                    });
                    return res.json({
                        success: true,
                        message: `Buy Request #${requestId} approved. Vehicle marked as Sold and seller contact unlocked.`,
                        status: "Approved",
                        saleStatus: "Sold"
                    });
                });
            });
        } else if (status === "Rejected") {
            // Reject request and release vehicle reservation back to Available!
            const rejectQuery = `
                UPDATE buy_requests
                SET status = 'Rejected'
                WHERE id = ?
            `;
            db.query(rejectQuery, [requestId], (rejectErr) => {
                if (rejectErr) {
                    console.error("Admin buy request reject error:", rejectErr);
                    return res.status(500).json({ success: false, message: "Could not reject request." });
                }
                // Release vehicle reservation back to Available so others can purchase
                db.query(
                    "UPDATE vehicles SET sale_status = 'Available' WHERE id = ? AND sale_status = 'Reserved'",
                    [request.vehicle_id],
                    (relErr) => {
                        if (relErr) console.error("Vehicle reservation release error:", relErr);
                    }
                );
                // Notify buyer by email
                const buyerQuery = `
                    SELECT br.*, v.brand, v.model
                    FROM buy_requests br
                    LEFT JOIN vehicles v ON br.vehicle_id = v.id
                    WHERE br.id = ?
                `;
                db.query(buyerQuery, [requestId], (bErr, bRows) => {
                    if (!bErr && bRows && bRows.length > 0) {
                        const bData = bRows[0];
                        emailTransporter.sendMail({
                            from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                            to: bData.buyer_email,
                            subject: `NAZ Purchase Request - Payment Verification Rejected (#${requestId})`,
                            html: `
                                <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #e2e8f0;border-radius:10px;">
                                    <h2 style="color:#b91c1c;margin-top:0;">Payment Verification Rejected</h2>
                                    <p>Dear <strong>${bData.buyer_name || 'Customer'}</strong>,</p>
                                    <p>Your payment screenshot for vehicle <strong>${bData.brand || ''} ${bData.model || ''}</strong> could not be verified by Admin and has been rejected.</p>
                                    <p>The vehicle reservation has been released back to the marketplace.</p>
                                    <p>If you believe this is an error, please contact NAZ Support.</p>
                                </div>
                            `
                        }).catch(e => console.error("Reject email err:", e.message));
                    }
                });
                return res.json({
                    success: true,
                    message: `Buy Request #${requestId} rejected and vehicle reservation released.`,
                    status: "Rejected"
                });
            });
        } else {
            // Update other allowed statuses
            const updateQuery = `
                UPDATE buy_requests
                SET status = ?
                WHERE id = ?
            `;
            db.query(updateQuery, [status, requestId], (updateErr, result) => {
                if (updateErr) {
                    console.error("Admin buy request status error:", updateErr);
                    return res.status(500).json({
                        success: false,
                        message: "Could not update status."
                    });
                }
                return res.json({
                    success: true,
                    message: `Buy Request #${requestId} marked as ${status}.`,
                    status: status
                });
            });
        }
    });
});
// 11. ADMIN: DELETE BUY REQUEST
app.delete("/api/admin/buy-requests/:id", (req, res) => {
    const requestId = req.params.id;
    db.query("SELECT payment_proof FROM buy_requests WHERE id = ?", [requestId], (err, results) => {
        if (results && results.length > 0 && results[0].payment_proof) {
            deleteFile(path.join(__dirname, results[0].payment_proof));
        }
        db.query("DELETE FROM buy_requests WHERE id = ?", [requestId], (delErr) => {
            if (delErr) {
                return res.status(500).json({ message: "Could not delete buy request." });
            }
            res.json({ success: true, message: "Buy request deleted successfully." });
        });
    });
});
// 12. Admin Stats Summary (Comprehensive KPIs)
app.get("/api/admin/stats", (req, res) => {
    const statsQuery = `
        SELECT 
            (SELECT COUNT(*) FROM vehicles) AS total_sell_vehicles,
            (SELECT COUNT(*) FROM vehicles WHERE status = 'Pending' OR status IS NULL) AS pending_sell_vehicles,
            (SELECT COUNT(*) FROM vehicles WHERE status = 'Approved') AS approved_sell_vehicles,
            (SELECT COUNT(*) FROM rental_vehicles) AS total_rental_vehicles,
            (SELECT COUNT(*) FROM rental_bookings) AS total_rental_bookings,
            (SELECT COUNT(*) FROM rental_bookings WHERE payment_status = 'Pending Verification') AS pending_payment_proofs,
            (SELECT COUNT(*) FROM rental_bookings WHERE booking_status = 'Confirmed') AS confirmed_rental_bookings,
            (SELECT COUNT(*) FROM buy_requests) AS total_buy_requests,
            (SELECT COUNT(*) FROM buy_requests WHERE status = 'Pending Verification') AS pending_buy_requests,
            (SELECT COUNT(*) FROM buy_requests WHERE status = 'Approved') AS approved_buy_requests,
            (
                (SELECT COALESCE(SUM(naz_fee), 0) FROM rental_bookings WHERE booking_status = 'Confirmed') +
                (SELECT COALESCE(SUM(naz_fee), 0) FROM buy_requests WHERE status = 'Approved')
            ) AS total_naz_fee_collected
    `;
    db.query(statsQuery, (err, results) => {
        if (err) {
            console.error("Admin stats error:", err);
            return res.status(500).json({ message: "Could not fetch stats." });
        }
        res.json(results[0]);
    });
});
// ============================================================
// AUTOMATIC SELLER RESPONSE EXPIRY (48 HOURS)
// ============================================================
function expireSellerConfirmationRequests() {
    const findQuery = `
        SELECT
            br.id,
            br.vehicle_id,
            br.buyer_name,
            br.buyer_email,
            v.brand,
            v.model
        FROM buy_requests br
        JOIN vehicles v ON br.vehicle_id = v.id
        WHERE br.status = 'Seller Confirmation Sent'
          AND br.seller_token_expiry IS NOT NULL
          AND br.seller_token_expiry <= NOW()
    `;
    db.query(findQuery, (err, rows) => {
        if (err) {
            console.error("Seller expiry check error:", err);
            return;
        }
        if (!rows || rows.length === 0) return;
        rows.forEach(request => {
            const expireQuery = `
                UPDATE buy_requests
                SET status = 'Seller Response Expired',
                    seller_token_hash = NULL,
                    seller_token_expiry = NULL
                WHERE id = ?
                  AND status = 'Seller Confirmation Sent'
                  AND seller_token_expiry <= NOW()
            `;
            db.query(expireQuery, [request.id], (updateErr, result) => {
                if (updateErr) {
                    console.error("Seller expiry update error:", updateErr);
                    return;
                }
                // Avoid processing an already answered request
                if (result.affectedRows === 0) return;
                // Remove vehicle from normal Buy listing
                const vehicleQuery = `
                    UPDATE vehicles
                    SET sale_status = 'Removed'
                    WHERE id = ?
                `;
                db.query(vehicleQuery, [request.vehicle_id], (vehicleErr) => {
                    if (vehicleErr) {
                        console.error("Expired vehicle removal error:", vehicleErr);
                    }
                    // Notify buyer by email
                    emailTransporter.sendMail({
                        from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                        to: request.buyer_email,
                        subject: `NAZ Purchase Request - Aap Ka Request Kiya Gaya Vehicle Available Nahi He (#${request.id})`,
                        html: `
                            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #fecaca;border-radius:10px;background:#fff5f5;">
                                <h2 style="color:#b91c1c;margin-top:0;">NAZ - Northern Automobile Zone</h2>
                                <p>Dear <strong>${request.buyer_name || "Customer"}</strong>,</p>
                                <div style="background:#fee2e2;border:1px solid #fca5a5;padding:15px;border-radius:8px;margin:15px 0;">
                                    <h3 style="margin:0 0 6px;color:#991b1b;">⚠️ Aap Ki Request Kiya Gaya Vehicle Available Nahi He</h3>
                                    <p style="margin:4px 0;color:#7f1d1d;"><strong>Vehicle:</strong> ${request.brand || ""} ${request.model || ""}</p>
                                    <p style="margin:4px 0;color:#7f1d1d;"><strong>Request ID:</strong> #${request.id}</p>
                                </div>
                                <p style="color:#374151;font-size:14.5px;line-height:1.6;">
                                    Seller ne 48 hours ke andar availability confirmation email ka response nahi diya. Is wajah se aap ki purchase request close kar di gayi hai aur vehicle Buy page se automatically remove kar diya gaya hai.
                                </p>
                                <p style="color:#15803d;font-weight:600;font-size:14px;">
                                    ✓ Aap se koi fees ya payment collect nahi ki gayi.
                                </p>
                                <p style="margin-top:20px;font-size:13.5px;color:#4b5563;">
                                    Aap NAZ Marketplace par doosri verified vehicles dekh sakte hain: 
                                    <a href="${process.env.FRONTEND_URL || 'http://localhost:5000'}/buy.html" style="color:#1e40af;font-weight:bold;">Browse Buy Page</a>
                                </p>
                                <p style="margin-top:25px;font-size:13px;color:#9ca3af;">Best Regards,<br>NAZ - Northern Automobile Zone</p>
                            </div>
                        `
                    })
                    .then(() => {
                        console.log(
                            `Request #${request.id} expired. Buyer email sent.`
                        );
                    })
                    .catch(emailError => {
                        console.error(
                            `Buyer expiry email failed for request #${request.id}:`,
                            emailError.message
                        );
                    });
                });
            });
        });
    });
}
// Check for expired requests every 60 seconds
setInterval(expireSellerConfirmationRequests, 60 * 1000);
// Also check once when server starts
expireSellerConfirmationRequests();
// ============================================================
// AUTOMATIC BUYER PAYMENT DEADLINE EXPIRY (24 HOURS)
// ============================================================
function expireBuyerPaymentRequests() {
    const findQuery = `
        SELECT
            br.id,
            br.vehicle_id,
            br.buyer_name,
            br.buyer_email,
            v.brand,
            v.model
        FROM buy_requests br
        JOIN vehicles v ON br.vehicle_id = v.id
        WHERE br.status = 'Awaiting Buyer Payment'
          AND br.buyer_payment_token_expiry IS NOT NULL
          AND br.buyer_payment_token_expiry <= NOW()
    `;
    db.query(findQuery, (err, rows) => {
        if (err) {
            console.error("Buyer payment deadline expiry check error:", err);
            return;
        }
        if (!rows || rows.length === 0) return;
        rows.forEach(request => {
            const cancelQuery = `
                UPDATE buy_requests
                SET status = 'Cancelled',
                    buyer_payment_token_hash = NULL,
                    buyer_payment_token_expiry = NULL
                WHERE id = ?
                  AND status = 'Awaiting Buyer Payment'
                  AND buyer_payment_token_expiry <= NOW()
            `;
            db.query(cancelQuery, [request.id], (upErr, result) => {
                if (upErr) {
                    console.error("Cancel buy request error:", upErr);
                    return;
                }
                if (result.affectedRows === 0) return;
                // Release vehicle reservation back to Available so other buyers can purchase
                db.query(
                    "UPDATE vehicles SET sale_status = 'Available' WHERE id = ? AND sale_status = 'Reserved'",
                    [request.vehicle_id],
                    (vehErr) => {
                        if (vehErr) console.error("Vehicle reservation release error:", vehErr);
                    }
                );
                // Notify buyer by email
                if (request.buyer_email) {
                    emailTransporter.sendMail({
                        from: `"NAZ - Northern Automobile Zone" <${process.env.EMAIL_USER}>`,
                        to: request.buyer_email,
                        subject: `NAZ Purchase Request Cancelled - Payment Deadline Expired (#${request.id})`,
                        html: `
                            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #e2e8f0;border-radius:10px;">
                                <h2 style="color:#b91c1c;margin-top:0;">NAZ - Northern Automobile Zone</h2>
                                <p>Dear <strong>${request.buyer_name || 'Customer'}</strong>,</p>
                                <p>Your 24-hour deadline to submit payment proof for vehicle <strong>${request.brand || ''} ${request.model || ''}</strong> (Request ID: #${request.id}) has expired.</p>
                                <p style="color:#7f1d1d;font-weight:bold;">
                                    As per our policy, your purchase request has been automatically Cancelled, and the vehicle reservation has been released back to the marketplace.
                                </p>
                                <p style="color:#64748b;font-size:13.5px;margin-top:20px;">
                                    If you still wish to purchase this or another vehicle, please visit the NAZ Marketplace and submit a new request.
                                </p>
                            </div>
                        `
                    }).catch(e => console.error("Buyer payment deadline expired email err:", e.message));
                }
                console.log(`Purchase request #${request.id} cancelled due to 24h payment deadline expiry. Vehicle #${request.vehicle_id} released.`);
            });
        });
    });
}
setInterval(expireBuyerPaymentRequests, 60 * 1000);
setTimeout(expireBuyerPaymentRequests, 5000);
// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log("==========================================");
    console.log("NAZ Backend Server Started");
    console.log(`Server running at http://localhost:${PORT}`);
    console.log("==========================================");
});
module.exports = app;