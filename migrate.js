const db = require("./db");

async function runMigration() {
    console.log("Starting NAZ database migration...");

    // 1. Ensure 'status' column exists in 'vehicles'
    await new Promise((resolve) => {
        db.query("SHOW COLUMNS FROM vehicles LIKE 'status'", (err, cols) => {
            if (cols && cols.length > 0) {
                console.log("vehicles.status column exists.");
                resolve();
            } else {
                db.query("ALTER TABLE vehicles ADD COLUMN status VARCHAR(50) DEFAULT 'Pending'", (alterErr) => {
                    if (alterErr) console.error("Error adding status to vehicles:", alterErr);
                    else console.log("Added status column to vehicles table.");
                    resolve();
                });
            }
        });
    });

    // Set existing sample vehicles to Approved so marketplace has verified listings
    await new Promise((resolve) => {
        db.query("UPDATE vehicles SET status = 'Approved' WHERE status IS NULL OR status = 'Pending'", (err, res) => {
            console.log("Existing vehicles updated to Approved:", res ? res.affectedRows : 0);
            resolve();
        });
    });

    // 2. Ensure owner columns in 'rental_vehicles'
    const addRentalCol = (colName, colDef) => new Promise((resolve) => {
        db.query(`SHOW COLUMNS FROM rental_vehicles LIKE '${colName}'`, (err, cols) => {
            if (cols && cols.length > 0) {
                console.log(`rental_vehicles.${colName} exists.`);
                resolve();
            } else {
                db.query(`ALTER TABLE rental_vehicles ADD COLUMN ${colName} ${colDef}`, (alterErr) => {
                    if (alterErr) console.error(`Error adding ${colName}:`, alterErr);
                    else console.log(`Added ${colName} to rental_vehicles.`);
                    resolve();
                });
            }
        });
    });

    await addRentalCol("owner_name", "VARCHAR(100) DEFAULT 'Muhammad Rashid'");
    await addRentalCol("owner_phone", "VARCHAR(20) DEFAULT '0345-9876543'");
    await addRentalCol("owner_email", "VARCHAR(150) DEFAULT 'rashid.owner@gmail.com'");

    const sampleOwners = [
        { id: 1, name: "Tariq Mehmood", phone: "0345-5123456", email: "tariq.rentals@gmail.com" },
        { id: 2, name: "Sajid Ali Khan", phone: "0312-9876543", email: "sajid.darel@gmail.com" },
        { id: 3, name: "Inayat Ullah", phone: "0300-8765432", email: "inayat.diamer@gmail.com" },
        { id: 4, name: "Haider Abbas", phone: "0333-7654321", email: "haider.cars@gmail.com" },
        { id: 5, name: "Zahid Hussain", phone: "0346-6543210", email: "zahid.roundu@gmail.com" },
        { id: 6, name: "Sher Baz Khan", phone: "0315-5432109", email: "sherbaz.rentals@gmail.com" },
        { id: 7, name: "Abdul Qadir", phone: "0301-4321098", email: "qadir.tangir@gmail.com" }
    ];

    for (const o of sampleOwners) {
        await new Promise((resolve) => {
            db.query(
                "UPDATE rental_vehicles SET owner_name = ?, owner_phone = ?, owner_email = ? WHERE id = ?",
                [o.name, o.phone, o.email, o.id],
                () => resolve()
            );
        });
    }
    console.log("Updated sample rental vehicle owner details.");

    // 3. Create 'buy_requests' table
    const createBuyRequestsQuery = `
        CREATE TABLE IF NOT EXISTS buy_requests (
            id INT AUTO_INCREMENT PRIMARY KEY,
            vehicle_id INT NOT NULL,
            buyer_name VARCHAR(100) NOT NULL,
            buyer_email VARCHAR(150) NOT NULL,
            buyer_phone VARCHAR(20) NOT NULL,
            vehicle_price DECIMAL(15, 2) NOT NULL,
            naz_fee DECIMAL(15, 2) NOT NULL,
            payment_method VARCHAR(50) NOT NULL,
            payment_proof VARCHAR(255) NULL,
            status VARCHAR(50) DEFAULT 'Pending Verification',
            transaction_id VARCHAR(100) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
        )
    `;

    await new Promise((resolve) => {
        db.query(createBuyRequestsQuery, (err) => {
            if (err) console.error("Error creating buy_requests table:", err);
            else console.log("buy_requests table is ready.");
            resolve();
        });
    });

    console.log("All DB migrations completed successfully!");
    process.exit(0);
}

runMigration().catch((e) => {
    console.error("Migration fatal error:", e);
    process.exit(1);
});
