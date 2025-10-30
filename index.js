require("dotenv").config()
const mongoose = require("mongoose")
const { createDAVClient } = require("tsdav")
const cron = require("node-cron")
const ClientModel = require("./models/Client")
const SyncLog = require("./models/SyncLog")

// --- Connect to Mongo ---
async function connectDB() {
	try {
		await mongoose.connect(process.env.MONGODB_URI)
		console.log("✅ MongoDB connected")
	} catch (err) {
		console.error("❌ MongoDB connection error:", err)
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
	console.log("🔄 Syncing iCloud contacts...")

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
		for (const addressBook of addressBooks) {
			const vcards = await client.fetchVCards({
				addressBook: addressBook,
			})

			for (const vcard of vcards) {
				const parsed = parseVCard(vcard.data)
				if (parsed) contacts.push(parsed)
			}
		}

		await syncToMongo(contacts)
		console.log(`✅ Synced ${contacts.length} contacts`)
	} catch (err) {
		console.error("❌ Error syncing contacts:", err.message)
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
	if (contacts.length === 0) return

	try {
		// Step 1: Get all existing contacts in ONE query
		const uniqueContactsMap = new Map()
		for (const contact of contacts) {
			// Keep the first occurrence of each phone number
			if (!uniqueContactsMap.has(contact.phone)) {
				uniqueContactsMap.set(contact.phone, contact)
			}
		}
		const uniqueContacts = Array.from(uniqueContactsMap.values())

		console.log(
			`   📋 Total contacts: ${contacts.length}, Unique: ${uniqueContacts.length}`
		)

		// Step 1: Get all existing contacts in ONE query
		const existingContactsMap = new Map(
			(await ClientModel.find({}, { phone: 1, full_name: 1 }).lean()).map(
				(c) => [c.phone, c.full_name]
			)
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

		// Step 3: Execute bulk operations
		let insertedCount = 0
		let updatedCount = 0

		if (toInsert.length > 0) {
			try {
				const result = await ClientModel.insertMany(toInsert, {
					ordered: false,
				})
				insertedCount = result.length
			} catch (err) {
				if (err.code === 11000 && err.insertedDocs) {
					insertedCount = err.insertedDocs.length
					console.warn(
						`⚠️ Some duplicates skipped during insert (${insertedCount} succeeded)`
					)
				} else {
					throw err // Re-throw if it's not a duplicate error
				}
			}
		}

		if (toUpdate.length > 0) {
			const result = await ClientModel.bulkWrite(toUpdate, {
				ordered: false,
			})
			updatedCount = result.modifiedCount
		}

		console.log(
			`   📊 Inserted: ${insertedCount}, Updated: ${updatedCount}, Skipped: ${
				contacts.length - insertedCount - updatedCount
			}`
		)

		await SyncLog.create({
			total_contacts: contacts.length,
			inserted: insertedCount,
			updated: updatedCount,
			skipped: contacts.length - insertedCount - updatedCount,
			success: true,
		})
	} catch (err) {
		console.error("❌ Sync error:", err.message)

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
			console.error("Failed to log error:", logErr.message)
		}
	}
}

// --- Schedule polling every 180 minutes ---
// cron.schedule("*/180 * * * *", fetchContacts)

// --- Start ---
// connectDB().then(fetchContacts)

// Solution: Generate an App-Specific Password
// Step 1: Go to Apple ID Settings
// Visit: https://appleid.apple.com/
// Sign in with your Apple ID
// Go to "Sign-In and Security" section
// Find "App-Specific Passwords"
// Step 2: Generate New Password
// Click "Generate an app-specific password"
// Enter a label like: Contact Syncer or CardDAV Access
// Apple will show you a password like: abcd-efgh-ijkl-mnop
// Copy this password immediately (you can't see it again!)
