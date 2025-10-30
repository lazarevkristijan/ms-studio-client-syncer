require("dotenv").config()
const mongoose = require("mongoose")
const { createDAVClient } = require("tsdav")
const cron = require("node-cron")
const ClientModel = require("./models/Client")

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

		const testContacts = contacts.slice(0, 1) // change
		console.log("🧪 TEST MODE: Only processing first contact")
		console.log("   Contact:", testContacts)

		await syncToMongo(testContacts)
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
		const existingContactsMap = new Map(
			(await ClientModel.find({}, { phone: 1, full_name: 1 }).lean()).map(
				(c) => [c.phone, c.full_name]
			)
		)

		// Step 2: Separate into inserts and updates
		const toInsert = []
		const toUpdate = []

		for (const contact of contacts) {
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
			const result = await ClientModel.insertMany(toInsert, {
				ordered: false,
			})
			insertedCount = result.length
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
	} catch (err) {
		if (err.code === 11000) {
			console.warn("⚠️ Some duplicate contacts detected, skipping...")
		} else {
			console.error("❌ Sync error:", err.message)
		}
	}
}

// --- Schedule polling every 120 minutes ---
cron.schedule("*/120 * * * *", fetchContacts)

// --- Start ---
connectDB().then(fetchContacts)
