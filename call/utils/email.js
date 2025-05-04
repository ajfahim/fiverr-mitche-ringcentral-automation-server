import nodemailer from "nodemailer";

/**
 * Send an email with the collected guest information
 * @param {Object} guestInfo - The guest information to send
 * @returns {Promise<boolean>} - Whether the email was sent successfully
 */
export async function sendGuestInfoEmail(guestInfo) {
  try {
    // Create a transporter using SMTP
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    // Format the guest information into a readable email body
    const emailBody = `
      New Booking Inquiry from Phone Call
      
      Guest Information:
      ------------------
      Name: ${guestInfo.guestName || "Not provided"}
      Phone Number: ${
        guestInfo.phoneNumber || "Not provided"
      } (Automatically captured from caller ID)
      Email: ${guestInfo.email || "Not provided"}
      
      Booking Details:
      ----------------
      Type of Tour: ${guestInfo.tourType || "Not provided"}
      Date of Arrival: ${guestInfo.dateOfArrival || "Not provided"}
      
      Additional Information (if provided):
      ------------------------------------
      Number of Adults: ${guestInfo.numberOfAdults || "Not specified"}
      Number of Children: ${guestInfo.numberOfChildren || "Not specified"}
      Time of Arrival: ${guestInfo.timeOfArrival || "Not specified"}
      
      Notes:
      ------
      ${guestInfo.notes || "No additional notes provided."}
      
      This information was collected via an automated phone call.
    `;

    // Send the email
    const info = await transporter.sendMail({
      from:
        process.env.SMTP_FROM ||
        '"Unique Tours Booking" <booking@uniquetoursandrentals.com>',
      // to: 'info@uniquetoursandrentals.com',
      to: process.env.SMTP_TO,
      subject: "New Booking Inquiry from Phone Call",
      text: emailBody,
    });

    console.log(`Email sent successfully: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
  }
}
