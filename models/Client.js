const mongoose = require("mongoose")

// !!!!modify here and in app
const clientSchema = new mongoose.Schema(
	{
		full_name: {
			type: String,
			required: true,
			trim: true,
		},
		phone: {
			type: String,
			required: false,
			trim: true,
		},
		notes: {
			type: String,
			required: false,
			trim: true,
			maxlength: 100,
			default: "",
		},
		isHidden: {
			type: Boolean,
			default: false,
		},
	},
	{
		timestamps: true,
	}
)

// Create a sparse unique index on phone - allows multiple null/empty values while maintaining uniqueness for non-empty values
clientSchema.index({ phone: 1 }, { unique: true, sparse: true })

module.exports = mongoose.model("Client", clientSchema)
