require("dotenv").config()
const mongoose = require("mongoose")
const { createDAVClient } = require("tsdav")
const fs = require("fs")
const path = require("path")
const ClientModel = require("./models/Client")
const SyncLog = require("./models/SyncLog")

// --- Logging Utility ---
const LOG_FILE = path.join(__dirname, "sync.log")

function log(level, message, data = null) {
	const timestamp = new Date().toISOString()
	const logLine = `[${timestamp}] [${level}] ${message}${
		data ? " | " + JSON.stringify(data) : ""
	}\n`

	// Write to file
	try {
		fs.appendFileSync(LOG_FILE, logLine)
	} catch (err) {
		console.error("Failed to write to log file:", err.message)
	}

	// Also log to console
	const consoleMsg = `[${level}] ${message}`
	if (level === "ERROR") {
		console.error(consoleMsg, data || "")
	} else if (level === "WARN") {
		console.warn(consoleMsg, data || "")
	} else {
		console.log(consoleMsg, data || "")
	}
}

// Helper functions for different log levels
const logger = {
	info: (msg, data) => log("INFO", msg, data),
	warn: (msg, data) => log("WARN", msg, data),
	error: (msg, data) => log("ERROR", msg, data),
	debug: (msg, data) => log("DEBUG", msg, data),
}

// --- Connect to Mongo ---
async function connectDB() {
	try {
		await mongoose.connect(process.env.MONGODB_URI, {
			serverSelectionTimeoutMS: 5000,
			socketTimeoutMS: 45000,
		})
		logger.info("✅ MongoDB connected successfully")

		// Monitor connection health
		mongoose.connection.on("error", (err) => {
			logger.error("MongoDB connection error", {
				error: err.message,
				stack: err.stack,
			})
		})

		mongoose.connection.on("disconnected", () => {
			logger.warn("⚠️ MongoDB disconnected")
		})

		mongoose.connection.on("reconnected", () => {
			logger.info("✅ MongoDB reconnected")
		})
	} catch (err) {
		logger.error("❌ Failed to connect to MongoDB", {
			error: err.message,
			stack: err.stack,
		})
		process.exit(1)
	}
}

// --- Normalize Phone Number ---
function normalizePhone(phone) {
	if (!phone) return null
	return phone.replace(/[\s\-\(\)]/g, "").trim()
}

// --- Fetch Contacts ---
async function fetchContacts() {
	const startTime = Date.now()
	logger.info("🔄 Starting iCloud contact sync...")

	try {
		// Create CardDAV client
		const client = await createDAVClient({
			serverUrl: "https://contacts.icloud.com",
			credentials: {
				username: process.env.APPLE_USERNAME,
				password: process.env.APPLE_APP_PASSWORD,
			},
			authMethod: "Basic",
			defaultAccountType: "carddav",
		})

		// Fetch address books
		const addressBooks = await client.fetchAddressBooks()
		const contacts = []

		// Fetch all contacts from all address books
		for (let i = 0; i < addressBooks.length; i++) {
			const addressBook = addressBooks[i]

			const vcards = await client.fetchVCards({
				addressBook: addressBook,
			})

			for (const vcard of vcards) {
				const parsed = parseVCard(vcard.data)
				if (parsed) {
					contacts.push(parsed)
				}
			}
		}

		logger.info(`Total contacts fetched from iCloud: ${contacts.length}`)
		await syncToMongo(contacts)

		const duration = ((Date.now() - startTime) / 1000).toFixed(2)
		logger.info(`✅ Sync completed successfully in ${duration}s`, {
			total_contacts: contacts.length,
			duration_seconds: duration,
		})
	} catch (err) {
		const duration = ((Date.now() - startTime) / 1000).toFixed(2)
		logger.error("❌ Error syncing contacts", {
			error: err.message,
			stack: err.stack,
			duration_seconds: duration,
		})
	}
}

// --- Parse vCard data ---
function parseVCard(vcardData) {
	try {
		// Parse vCard format (basic parser)
		const lines = vcardData.split("\n")
		let full_name = null
		let phone = null

		for (const line of lines) {
			const trimmedLine = line.trim()

			if (line.startsWith("FN:")) {
				full_name = line.substring(3).trim()
			}
			if (trimmedLine.match(/^(item\d+\.)?TEL/i)) {
				const match = trimmedLine.match(/:(.+)$/)
				if (match) {
					phone = normalizePhone(match[1])
					// Break after first phone (takes the first/preferred number)
					break
				}
			}
		}

		if (!full_name || !phone) return null
		return { full_name, phone }
	} catch (e) {
		return null
	}
}

// --- Sync to MongoDB (OPTIMIZED) ---
async function syncToMongo(contacts) {
	if (contacts.length === 0) {
		logger.warn("No contacts to sync, skipping...")
		return
	}

	try {
		// Step 0: Deduplicate contacts from iCloud
		const uniqueContactsMap = new Map()
		for (const contact of contacts) {
			// Keep the first occurrence of each phone number
			if (!uniqueContactsMap.has(contact.phone)) {
				uniqueContactsMap.set(contact.phone, contact)
			}
		}
		const uniqueContacts = Array.from(uniqueContactsMap.values())
		const duplicatesRemoved = contacts.length - uniqueContacts.length

		logger.info(`Deduplication complete`, {
			total: contacts.length,
			unique: uniqueContacts.length,
			duplicates_removed: duplicatesRemoved,
		})

		// Step 1: Get all existing contacts in ONE query
		const existingContacts = await ClientModel.find(
			{},
			{ phone: 1, full_name: 1 }
		).lean()
		const existingContactsMap = new Map(
			existingContacts.map((c) => [c.phone, c.full_name])
		)

		// Step 2: Separate into inserts and updates
		const toInsert = []
		const toUpdate = []

		for (const contact of uniqueContacts) {
			if (!existingContactsMap.has(contact.phone)) {
				// New contact
				toInsert.push({
					full_name: contact.full_name,
					phone: contact.phone,
				})
			} else if (
				existingContactsMap.get(contact.phone) !== contact.full_name
			) {
				// Existing contact with changed name
				toUpdate.push({
					updateOne: {
						filter: { phone: contact.phone },
						update: {
							$set: {
								full_name: contact.full_name,
							},
						},
					},
				})
			}
		}

		logger.info(`Change detection complete`, {
			to_insert: toInsert.length,
			to_update: toUpdate.length,
			unchanged:
				uniqueContacts.length - toInsert.length - toUpdate.length,
		})

		// Step 3: Execute bulk operations
		let insertedCount = 0
		let updatedCount = 0

		if (toInsert.length > 0) {
			try {
				const result = await ClientModel.insertMany(toInsert, {
					ordered: false,
				})
				insertedCount = result.length
				logger.info(`Successfully inserted ${insertedCount} contacts`)
			} catch (err) {
				if (err.code === 11000 && err.insertedDocs) {
					insertedCount = err.insertedDocs.length
					logger.warn(`Some duplicates skipped during insert`, {
						succeeded: insertedCount,
						attempted: toInsert.length,
					})
				} else {
					logger.error("Insert operation failed", {
						error: err.message,
					})
					throw err // Re-throw if it's not a duplicate error
				}
			}
		}

		if (toUpdate.length > 0) {
			const result = await ClientModel.bulkWrite(toUpdate, {
				ordered: false,
			})
			updatedCount = result.modifiedCount
			logger.info(`Successfully updated ${updatedCount} contacts`)
		}

		const skipped = uniqueContacts.length - insertedCount - updatedCount

		logger.info(`📊 Sync summary`, {
			inserted: insertedCount,
			updated: updatedCount,
			skipped: skipped,
			total: uniqueContacts.length,
		})

		await SyncLog.create({
			total_contacts: uniqueContacts.length,
			inserted: insertedCount,
			updated: updatedCount,
			skipped: skipped,
			success: true,
		})
	} catch (err) {
		logger.error("❌ Sync to MongoDB failed", {
			error: err.message,
			stack: err.stack,
		})

		// Log the failed sync
		try {
			await SyncLog.create({
				total_contacts: contacts.length,
				inserted: 0,
				updated: 0,
				skipped: 0,
				success: false,
				error_message: err.message,
			})
		} catch (logErr) {
			logger.error("Failed to save error to SyncLog", {
				error: logErr.message,
			})
		}

		// Re-throw to be caught by fetchContacts
		throw err
	}
}

// --- Global Error Handlers ---
process.on("uncaughtException", (err) => {
	logger.error("💥 UNCAUGHT EXCEPTION - Process will continue", {
		error: err.message,
		stack: err.stack,
	})
	// Don't exit - keep cron running
})

process.on("unhandledRejection", (reason, promise) => {
	logger.error("💥 UNHANDLED REJECTION - Process will continue", {
		reason: reason,
		promise: promise,
	})
	// Don't exit - keep cron running
})

// Graceful shutdown on SIGTERM
process.on("SIGTERM", () => {
	logger.info("👋 SIGTERM received, closing gracefully")
	mongoose.connection.close()
	process.exit(0)
})

// Graceful shutdown on SIGINT (Ctrl+C)
process.on("SIGINT", () => {
	logger.info("👋 SIGINT received, closing gracefully")
	mongoose.connection.close()
	process.exit(0)
})

// --- Main Execution Function ---
async function main() {
	try {
		logger.info("🚀 Contact Sync Job Starting...")

		await connectDB()

		await fetchContacts()

		await mongoose.connection.close()
		logger.info("👋 Database connection closed")

		process.exit(0)
	} catch (err) {
		logger.error("❌ Sync job failed", {
			error: err.message,
			stack: err.stack,
		})

		try {
			await mongoose.connection.close()
		} catch (closeErr) {
			logger.error("Failed to close database connection", {
				error: closeErr.message,
			})
		}

		process.exit(1)
	}
}

// --- Start Execution ---
main()
