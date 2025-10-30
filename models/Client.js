const mongoose = require("mongoose")

const clientSchema = new mongoose.Schema(
	{
		full_name: {
			type: String,
			required: true,
			trim: true,
		},
		phone: {
			type: String,
			required: true,
			trim: true,
			unique: true,
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

module.exports = mongoose.model("Client", clientSchema)
