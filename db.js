const fs = require("fs");
const path = require("path");
const mysql = require("mysql2");

const localDbFile = path.join(__dirname, "local_db.json");

// In-memory data cache
let localDb = {
    vehicles: [],
    buy_requests: [],
    rental_vehicles: [],
    rental_bookings: [],
    users: []
};

function loadLocalDb() {
    try {
        if (fs.existsSync(localDbFile)) {
            const data = fs.readFileSync(localDbFile, "utf-8");
            localDb = JSON.parse(data);
        }
    } catch (e) {
        console.error("Error loading local_db.json:", e.message);
    }
}

function saveLocalDb() {
    try {
        fs.writeFileSync(localDbFile, JSON.stringify(localDb, null, 2), "utf-8");
    } catch (e) {
        console.error("Error saving local_db.json:", e.message);
    }
}

loadLocalDb();

let isMysqlConnected = false;
let mysqlConn = null;

try {
    mysqlConn = mysql.createConnection({
        host: "localhost",
        user: "root",
        password: "12345",
        database: "naz_db",
        connectTimeout: 2000
    });

    mysqlConn.connect((err) => {
        if (err) {
            console.log("ℹ️ MySQL not reachable (" + err.message + "). Using resilient local JSON database.");
            isMysqlConnected = false;
        } else {
            console.log("✅ MySQL database connected successfully!");
            isMysqlConnected = true;
        }
    });

    mysqlConn.on("error", (err) => {
        console.log("MySQL connection notice:", err.message);
        isMysqlConnected = false;
    });
} catch (e) {
    console.log("MySQL initialization notice:", e.message);
    isMysqlConnected = false;
}

// Fallback SQL query handler
function fallbackQuery(sql, params, callback) {
    if (typeof params === "function") {
        callback = params;
        params = [];
    }
    if (!callback) callback = () => {};

    const cleanSql = sql.replace(/\s+/g, " ").trim();
    loadLocalDb();

    // 1. SHOW COLUMNS / ALTER TABLE / CREATE TABLE
    if (cleanSql.startsWith("SHOW COLUMNS") || cleanSql.startsWith("ALTER TABLE") || cleanSql.startsWith("CREATE TABLE")) {
        return setImmediate(() => callback(null, [{ Field: "status" }, { Field: "payment_proof" }]));
    }

    // 2. STATS QUERY
    if (cleanSql.includes("total_sell_vehicles") || (cleanSql.startsWith("SELECT") && cleanSql.includes("total_buy_requests"))) {
        const total_sell_vehicles = localDb.vehicles.length;
        const pending_sell_vehicles = localDb.vehicles.filter(v => (v.status || "Pending") === "Pending").length;
        const approved_sell_vehicles = localDb.vehicles.filter(v => v.status === "Approved").length;
        const total_rental_vehicles = localDb.rental_vehicles.length;
        const total_rental_bookings = localDb.rental_bookings.length;
        const pending_payment_proofs = localDb.rental_bookings.filter(b => b.payment_status === "Pending Verification").length;
        const confirmed_rental_bookings = localDb.rental_bookings.filter(b => b.booking_status === "Confirmed").length;
        const total_buy_requests = localDb.buy_requests.length;
        const pending_buy_requests = localDb.buy_requests.filter(br => br.status === "Pending Verification").length;
        const approved_buy_requests = localDb.buy_requests.filter(br => br.status === "Approved").length;

        const buyFees = localDb.buy_requests
            .filter(br => br.status === "Approved")
            .reduce((sum, br) => sum + (Number(br.naz_fee) || 0), 0);
        const rentalFees = localDb.rental_bookings
            .filter(b => b.booking_status === "Confirmed")
            .reduce((sum, b) => sum + (Number(b.naz_fee) || 0), 0);
        const total_naz_fee_collected = buyFees + rentalFees;

        return setImmediate(() => callback(null, [{
            total_sell_vehicles,
            pending_sell_vehicles,
            approved_sell_vehicles,
            total_rental_vehicles,
            total_rental_bookings,
            pending_payment_proofs,
            confirmed_rental_bookings,
            total_buy_requests,
            pending_buy_requests,
            approved_buy_requests,
            total_naz_fee_collected
        }]));
    }

    // 3. VEHICLES QUERIES
    // A. SELECT FROM VEHICLES
    if (cleanSql.startsWith("SELECT") && cleanSql.includes("FROM vehicles")) {
        // By ID
        if (cleanSql.includes("WHERE id = ?")) {
            const vId = Number(params[0]);
            const match = localDb.vehicles.filter(v => Number(v.id) === vId);
            return setImmediate(() => callback(null, match));
        }

        // By Status
        if (cleanSql.includes("WHERE status = 'Approved'")) {
            if (cleanSql.includes("sale_status = 'Sold'")) {
                const filtered = localDb.vehicles.filter(v => v.status === "Approved" && v.sale_status === "Sold").reverse();
                return setImmediate(() => callback(null, filtered));
            }
            const filtered = localDb.vehicles.filter(v => v.status === "Approved" && (v.sale_status === "Available" || v.sale_status === "Reserved" || !v.sale_status)).reverse();
            return setImmediate(() => callback(null, filtered));
        }

        if (cleanSql.includes("WHERE status = ?")) {
            const st = params[0];
            const filtered = localDb.vehicles.filter(v => v.status === st).reverse();
            return setImmediate(() => callback(null, filtered));
        }

        // All vehicles
        return setImmediate(() => callback(null, [...localDb.vehicles].reverse()));
    }

    // B. INSERT INTO VEHICLES
    if (cleanSql.startsWith("INSERT INTO vehicles")) {
        const nextId = localDb.vehicles.length > 0 ? Math.max(...localDb.vehicles.map(v => Number(v.id) || 0)) + 1 : 1;
        const newVehicle = {
            id: nextId,
            seller_name: params[0],
            seller_email: params[1],
            seller_phone: params[2],
            seller_location: params[3],
            seller_address: params[4],
            seller_id_card: params[5],
            vehicle_type: params[6],
            registration_type: params[7],
            brand: params[8],
            model: params[9],
            manufacturing_year: params[10],
            engine_cc: params[11],
            mileage: params[12],
            asking_price: params[13],
            chassis_number: params[14],
            engine_number: params[15],
            vehicle_condition: params[16],
            fuel_type: params[17],
            transmission: params[18],
            registration_number: params[19],
            vehicle_make_model_year: params[20],
            customs_paid_status: params[21],
            vehicle_description: params[22],
            registration_document: params[23],
            bike_document: params[24],
            vehicle_images: params[25],
            verification_status: "Pending",
            status: "Pending",
            created_at: new Date().toISOString()
        };
        localDb.vehicles.push(newVehicle);
        saveLocalDb();
        return setImmediate(() => callback(null, { insertId: nextId, affectedRows: 1 }));
    }

    // C. UPDATE VEHICLES STATUS
    if (cleanSql.startsWith("UPDATE vehicles SET status = ?, verification_status = ? WHERE id = ?")) {
        const newStatus = params[0];
        const verStatus = params[1];
        const vId = Number(params[2]);
        const v = localDb.vehicles.find(item => Number(item.id) === vId);
        if (v) {
            v.status = newStatus;
            v.verification_status = verStatus;
            saveLocalDb();
            return setImmediate(() => callback(null, { affectedRows: 1 }));
        }
        return setImmediate(() => callback(null, { affectedRows: 0 }));
    }

    if (cleanSql.includes("UPDATE vehicles SET sale_status =")) {
        let newSaleStatus = null;
        if (cleanSql.includes("sale_status = 'Reserved'")) newSaleStatus = 'Reserved';
        else if (cleanSql.includes("sale_status = 'Available'")) newSaleStatus = 'Available';
        else if (cleanSql.includes("sale_status = 'Sold'")) newSaleStatus = 'Sold';
        else if (cleanSql.includes("sale_status = 'Removed'")) newSaleStatus = 'Removed';

        const vId = Number(params[params.length - 1] !== undefined ? params[params.length - 1] : params[0]);
        const v = localDb.vehicles.find(item => Number(item.id) === vId);
        if (v && newSaleStatus) {
            v.sale_status = newSaleStatus;
            saveLocalDb();
            return setImmediate(() => callback(null, { affectedRows: 1 }));
        }
        return setImmediate(() => callback(null, { affectedRows: 0 }));
    }

    // D. DELETE VEHICLES
    if (cleanSql.startsWith("DELETE FROM vehicles WHERE id = ?")) {
        const vId = Number(params[0]);
        localDb.vehicles = localDb.vehicles.filter(v => Number(v.id) !== vId);
        saveLocalDb();
        return setImmediate(() => callback(null, { affectedRows: 1 }));
    }

    // 4. BUY REQUESTS QUERIES
    // A. INSERT INTO buy_requests
    if (cleanSql.startsWith("INSERT INTO buy_requests")) {
        const nextId = localDb.buy_requests.length > 0 ? Math.max(...localDb.buy_requests.map(br => Number(br.id) || 0)) + 1 : 1;
        const newReq = {
            id: nextId,
            vehicle_id: Number(params[0]),
            buyer_name: params[1],
            buyer_email: params[2],
            buyer_phone: params[3],
            vehicle_price: Number(params[4]),
            naz_fee: Number(params[5]),
            payment_method: params[6] || null,
            status: "Pending Seller Confirmation",
            transaction_id: null,
            payment_proof: null,
            seller_response: null,
            seller_token_hash: null,
            seller_token_expiry: null,
            buyer_payment_token_hash: null,
            buyer_payment_token_expiry: null,
            created_at: new Date().toISOString().replace("T", " ").substring(0, 19)
        };
        localDb.buy_requests.push(newReq);
        saveLocalDb();
        return setImmediate(() => callback(null, { insertId: nextId, affectedRows: 1 }));
    }

    // B. UPDATE buy_requests (Comprehensive handler)
    if (cleanSql.includes("UPDATE buy_requests")) {
        // Match by id or token_hash
        let req = null;

        if (cleanSql.includes("WHERE id = ?")) {
            const reqId = Number(params[params.length - 1]);
            req = localDb.buy_requests.find(b => Number(b.id) === reqId);
        } else if (cleanSql.includes("seller_token_hash = ?")) {
            const hashVal = params[params.length - 1];
            req = localDb.buy_requests.find(b => b.seller_token_hash === hashVal);
        }

        if (cleanSql.includes("SET seller_token_hash = ?") && cleanSql.includes("seller_token_expiry = ?")) {
            // params: [tokenHash, expiry, buyRequestId]
            const reqId = Number(params[2]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.seller_token_hash = params[0];
                target.seller_token_expiry = params[1] ? new Date(params[1]).toISOString() : null;
                target.status = "Seller Confirmation Sent";
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("SET seller_response = ?")) {
            // params: [response, newStatus, request.id, tokenHash]
            const resp = params[0];
            const newStatus = params[1];
            const reqId = Number(params[2]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.seller_response = resp;
                target.status = newStatus;
                target.seller_token_hash = null;
                target.seller_token_expiry = null;
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("SET buyer_payment_token_hash = ?")) {
            // params: [tokenHash, expiry, buyRequestId]
            const reqId = Number(params[2]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.buyer_payment_token_hash = params[0];
                target.buyer_payment_token_expiry = params[1] ? new Date(params[1]).toISOString() : null;
                target.status = "Awaiting Buyer Payment";
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("SET payment_method = ?") && cleanSql.includes("transaction_id = ?")) {
            // params: [payment_method, transactionId, buy_request_id]
            const reqId = Number(params[2]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.payment_method = params[0];
                target.transaction_id = params[1];
                target.status = "Awaiting Proof";
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("SET payment_proof = ?")) {
            // params: [imagePath, paymentMethod, buyRequestId] OR [proofPath, reqId]
            const proofPath = params[0];
            const reqId = Number(params[params.length - 1]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.payment_proof = proofPath;
                if (params.length >= 3 && params[1]) {
                    target.payment_method = params[1];
                }
                target.status = "Pending Verification";
                target.buyer_payment_token_hash = null;
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("SET status = ? WHERE id = ?")) {
            const st = params[0];
            const reqId = Number(params[1]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.status = st;
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("SET status = 'Approved' WHERE id = ?")) {
            const reqId = Number(params[0]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.status = "Approved";
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("SET status = 'Rejected' WHERE id = ?")) {
            const reqId = Number(params[0]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.status = "Rejected";
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("status = 'Seller Response Expired'")) {
            const reqId = Number(params[0]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.status = "Seller Response Expired";
                target.seller_token_hash = null;
                target.seller_token_expiry = null;
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }

        if (cleanSql.includes("status = 'Cancelled'")) {
            const reqId = Number(params[0]);
            const target = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (target) {
                target.status = "Cancelled";
                target.buyer_payment_token_hash = null;
                target.buyer_payment_token_expiry = null;
                saveLocalDb();
                return setImmediate(() => callback(null, { affectedRows: 1 }));
            }
            return setImmediate(() => callback(null, { affectedRows: 0 }));
        }
    }

    // D. DELETE FROM buy_requests
    if (cleanSql.startsWith("DELETE FROM buy_requests WHERE id = ?")) {
        const reqId = Number(params[0]);
        localDb.buy_requests = localDb.buy_requests.filter(b => Number(b.id) !== reqId);
        saveLocalDb();
        return setImmediate(() => callback(null, { affectedRows: 1 }));
    }

    // E. SELECT FROM buy_requests WITH JOIN ON vehicles
    if (cleanSql.includes("FROM buy_requests") || cleanSql.includes("FROM buy_requests br")) {
        // By seller_token_hash
        if (cleanSql.includes("WHERE seller_token_hash = ?") || cleanSql.includes("seller_token_hash = ?")) {
            const hashVal = params[0];
            const target = localDb.buy_requests.find(b => b.seller_token_hash === hashVal);
            return setImmediate(() => callback(null, target ? [target] : []));
        }

        // Expired seller confirmation checks
        if (cleanSql.includes("WHERE br.status = 'Seller Confirmation Sent'") || cleanSql.includes("status = 'Seller Confirmation Sent'")) {
            const now = new Date();
            const expired = localDb.buy_requests.filter(b =>
                b.status === "Seller Confirmation Sent" &&
                b.seller_token_expiry &&
                new Date(b.seller_token_expiry) <= now
            ).map(req => {
                const veh = localDb.vehicles.find(v => Number(v.id) === Number(req.vehicle_id)) || {};
                return {
                    id: req.id,
                    vehicle_id: req.vehicle_id,
                    buyer_name: req.buyer_name,
                    buyer_email: req.buyer_email,
                    brand: veh.brand,
                    model: veh.model
                };
            });
            return setImmediate(() => callback(null, expired));
        }

        // Expired buyer payment deadline checks
        if (cleanSql.includes("WHERE br.status = 'Awaiting Buyer Payment'") || cleanSql.includes("status = 'Awaiting Buyer Payment'")) {
            const now = new Date();
            const expired = localDb.buy_requests.filter(b =>
                b.status === "Awaiting Buyer Payment" &&
                b.buyer_payment_token_expiry &&
                new Date(b.buyer_payment_token_expiry) <= now
            ).map(req => {
                const veh = localDb.vehicles.find(v => Number(v.id) === Number(req.vehicle_id)) || {};
                return {
                    id: req.id,
                    vehicle_id: req.vehicle_id,
                    buyer_name: req.buyer_name,
                    buyer_email: req.buyer_email,
                    brand: veh.brand,
                    model: veh.model
                };
            });
            return setImmediate(() => callback(null, expired));
        }

        // Single request lookup by ID: WHERE br.id = ? OR WHERE id = ?
        if ((cleanSql.includes("WHERE br.id = ?") || cleanSql.includes("WHERE id = ?")) && !cleanSql.includes("OR")) {
            const reqId = Number(params[0]);
            const req = localDb.buy_requests.find(b => Number(b.id) === reqId);
            if (!req) return setImmediate(() => callback(null, []));
            const veh = localDb.vehicles.find(v => Number(v.id) === Number(req.vehicle_id)) || {};
            const joined = {
                ...req,
                vehicle_id: req.vehicle_id,
                brand: veh.brand,
                model: veh.model,
                manufacturing_year: veh.manufacturing_year,
                asking_price: veh.asking_price,
                seller_name: veh.seller_name,
                seller_email: veh.seller_email,
                seller_phone: veh.seller_phone,
                seller_location: veh.seller_location,
                seller_address: veh.seller_address,
                vehicle_images: veh.vehicle_images
            };
            return setImmediate(() => callback(null, [joined]));
        }

        // Search track: WHERE br.id = ? OR br.buyer_phone = ? OR br.buyer_email = ?
        if (cleanSql.includes("OR br.buyer_phone = ?")) {
            const queryVal = String(params[0]).trim();
            const matches = localDb.buy_requests.filter(b =>
                String(b.id) === queryVal ||
                String(b.buyer_phone).trim() === queryVal ||
                String(b.buyer_email).toLowerCase().trim() === queryVal.toLowerCase()
            ).reverse();

            const joinedList = matches.map(req => {
                const veh = localDb.vehicles.find(v => Number(v.id) === Number(req.vehicle_id)) || {};
                return {
                    ...req,
                    brand: veh.brand,
                    model: veh.model,
                    manufacturing_year: veh.manufacturing_year,
                    asking_price: veh.asking_price,
                    seller_name: veh.seller_name,
                    seller_phone: veh.seller_phone,
                    seller_location: veh.seller_location,
                    seller_address: veh.seller_address
                };
            });
            return setImmediate(() => callback(null, joinedList));
        }

        // All buy requests for Admin
        const allJoined = localDb.buy_requests.map(req => {
            const veh = localDb.vehicles.find(v => Number(v.id) === Number(req.vehicle_id)) || {};
            return {
                ...req,
                vehicle_brand: veh.brand,
                vehicle_model: veh.model,
                vehicle_year: veh.manufacturing_year,
                original_price: veh.asking_price,
                seller_name: veh.seller_name,
                seller_phone: veh.seller_phone,
                seller_location: veh.seller_location,
                vehicle_images: veh.vehicle_images
            };
        }).reverse();
        return setImmediate(() => callback(null, allJoined));
    }

    // 5. RENTAL VEHICLES & BOOKINGS
    if (cleanSql.includes("FROM rental_vehicles")) {
        if (cleanSql.includes("WHERE id = ?")) {
            const rId = Number(params[0]);
            return setImmediate(() => callback(null, localDb.rental_vehicles.filter(rv => Number(rv.id) === rId)));
        }
        return setImmediate(() => callback(null, [...localDb.rental_vehicles].reverse()));
    }

    if (cleanSql.includes("FROM rental_bookings")) {
        if (cleanSql.includes("WHERE id = ?") || cleanSql.includes("WHERE b.id = ?")) {
            const bId = Number(params[0]);
            return setImmediate(() => callback(null, localDb.rental_bookings.filter(b => Number(b.id) === bId)));
        }

        // Admin rental bookings with join
        const allBookings = localDb.rental_bookings.map(b => {
            const veh = localDb.rental_vehicles.find(rv => Number(rv.id) === Number(b.vehicle_id)) || {};
            return {
                ...b,
                pickup_date_formatted: b.pickup_date,
                return_date_formatted: b.return_date,
                vehicle_brand: veh.brand,
                vehicle_model: veh.model,
                vehicle_year: veh.manufacturing_year,
                vehicle_location: veh.location,
                vehicle_images: veh.image_path,
                owner_name: veh.owner_name,
                owner_phone: veh.owner_phone
            };
        }).reverse();
        return setImmediate(() => callback(null, allBookings));
    }

    if (cleanSql.startsWith("UPDATE rental_bookings")) {
        const bStatus = params[0];
        const pStatus = params[1];
        const bId = Number(params[2]);
        const b = localDb.rental_bookings.find(item => Number(item.id) === bId);
        if (b) {
            b.booking_status = bStatus;
            b.payment_status = pStatus;
            saveLocalDb();
            return setImmediate(() => callback(null, { affectedRows: 1 }));
        }
        return setImmediate(() => callback(null, { affectedRows: 0 }));
    }

    if (cleanSql.startsWith("DELETE FROM rental_bookings")) {
        const bId = Number(params[0]);
        localDb.rental_bookings = localDb.rental_bookings.filter(item => Number(item.id) !== bId);
        saveLocalDb();
        return setImmediate(() => callback(null, { affectedRows: 1 }));
    }

    // Fallback default response
    return setImmediate(() => callback(null, []));
}

// Export database object with transparent .query method
const db = {
    query: function (sql, params, callback) {
        if (typeof params === "function") {
            callback = params;
            params = [];
        }

        if (isMysqlConnected && mysqlConn) {
            return mysqlConn.query(sql, params, (err, results, fields) => {
                if (err) {
                    console.error("MySQL query error, attempting fallback:", err.message);
                    return fallbackQuery(sql, params, callback);
                }
                callback(null, results, fields);
            });
        } else {
            return fallbackQuery(sql, params, callback);
        }
    }
};

module.exports = db;