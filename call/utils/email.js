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

    // Remove any placeholder values that might be in the data
    const cleanGuestInfo = {
      ...guestInfo,
      guestName: guestInfo.guestName?.includes('[Your') ? 'Not provided' : (guestInfo.guestName || 'Not provided'),
      email: guestInfo.email?.includes('[Your') ? 'Not provided' : (guestInfo.email || 'Not provided'),
    };
    
    // Format the guest information into a readable email body
    const emailBody = `
      New Booking Inquiry from Phone Call
      
      Guest Information:
      ------------------
      Name of the reservation: ${cleanGuestInfo.guestName}
      Email: ${cleanGuestInfo.email}
      Phone number: ${cleanGuestInfo.phoneNumber || "Not provided"} (Automatically captured from caller ID)
      
      Booking Details:
      ----------------
      Number of guests: ${cleanGuestInfo.numberOfGuests || "Not provided"}
      Type of Tour: ${cleanGuestInfo.tourType || "Not provided"}
      Tour Date: ${cleanGuestInfo.tourDate || "Not provided"}
      Tour Time: ${cleanGuestInfo.tourTime || "Not provided"}
      
      Additional Information:
      ---------------------
      Weight of each rider: ${cleanGuestInfo.notes && cleanGuestInfo.notes.includes("weight") ? 
        cleanGuestInfo.notes.split("\n").find(line => line.toLowerCase().includes("weight")) : "Not provided"}
      
      Transportation needed: ${cleanGuestInfo.notes && cleanGuestInfo.notes.includes("transportation") ? 
        cleanGuestInfo.notes.split("\n").find(line => line.toLowerCase().includes("transportation")) : "Not provided"}
      
      Notes:
      ------
      ${cleanGuestInfo.notes || "No additional notes provided."}
      
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
