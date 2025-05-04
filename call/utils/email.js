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
      Email: ${guestInfo.email || "Not provided"}
      Phone Number: ${guestInfo.phoneNumber || "Not provided"}
      
      Booking Details:
      ----------------
      Number of Adults: ${guestInfo.numberOfAdults || "Not provided"}
      Number of Children: ${guestInfo.numberOfChildren || "Not provided"}
      Date of Arrival: ${guestInfo.dateOfArrival || "Not provided"}
      Time of Arrival: ${guestInfo.timeOfArrival || "Not provided"}
      Type of Tour: ${guestInfo.tourType || "Not provided"}
      
      Additional Notes:
      ----------------
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
