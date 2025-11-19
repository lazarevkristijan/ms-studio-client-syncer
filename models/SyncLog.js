const mongoose = require("mongoose")

// !!!!modify here and in app
const syncLogSchema = new mongoose.Schema(
	{
		total_contacts: Number,
		inserted: Number,
		updated: Number,
		skipped: Number,
		success: { type: Boolean, default: true },
		error_message: { type: String, default: null },
	},
	{ timestamps: true }
)

module.exports = mongoose.model("SyncLog", syncLogSchema)
