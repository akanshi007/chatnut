// Email and OTP dispatch service

const tls = require("tls");
const net = require("net");

let nodemailer = null;
try {
    nodemailer = require("nodemailer");
} catch (e) {
    // Nodemailer not installed, built-in TLS SMTP client will handle dispatch
}

// Send OTP verification code
async function sendOtpEmail(toEmail, otp, type = "signup", recipientName = "User") {
    const isSignup = type === "signup";
    const subject = isSignup 
        ? "Verify your chatNut Account - Verification Code" 
        : "Reset your chatNut Password - Verification Code";

    const title = isSignup ? "Welcome to chatNut!" : "Reset Your Password";
    const message = isSignup
        ? "Thank you for joining chatNut. Use the 6-digit verification code below to complete your registration and start chatting:"
        : "We received a request to reset your chatNut account password. Use the 6-digit verification code below to set a new password:";

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; }
        .email-card { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border-top: 5px solid #ff8800; }
        .header { background: #1a1a24; padding: 24px; text-align: center; color: #ffffff; }
        .header h1 { margin: 0; font-size: 24px; letter-spacing: 0.5px; }
        .header h1 span { color: #ff8800; }
        .content { padding: 30px 24px; color: #333333; line-height: 1.6; }
        .otp-box { background: #fff8f0; border: 2px dashed #ff8800; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0; }
        .otp-code { font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #ff8800; font-family: monospace; }
        .footer { background: #fafafa; padding: 16px; text-align: center; font-size: 12px; color: #888888; border-top: 1px solid #eeeeee; }
      </style>
    </head>
    <body>
      <div class="email-card">
        <div class="header">
          <h1>chat<span>Nut</span></h1>
        </div>
        <div class="content">
          <h2>Hello, ${escapeHtml(recipientName)}!</h2>
          <p>${message}</p>
          <div class="otp-box">
            <div class="otp-code">${otp}</div>
            <small style="color: #666; display: block; margin-top: 6px;">This code will expire in 10 minutes.</small>
          </div>
          <p style="font-size: 13px; color: #777;">If you did not make this request, you can safely ignore this email.</p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} chatNut Messenger. All rights reserved.
        </div>
      </div>
    </body>
    </html>
    `;

    const textContent = `${title}\n\nHello ${recipientName},\n\n${message}\n\nVerification Code: ${otp}\n\nThis code will expire in 10 minutes.\n\nIf you did not request this, please ignore this email.`;

    console.log(`[Auth] OTP generated for ${toEmail} (${type}): ${otp}`);

    // Read SMTP configuration from environment
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_PASS ? process.env.GMAIL_PASS.replace(/\s+/g, "") : null;

    const smtpHost = process.env.SMTP_HOST || (gmailUser ? "smtp.gmail.com" : null);
    const smtpPort = parseInt(process.env.SMTP_PORT || (smtpHost === "smtp.gmail.com" ? "465" : "587"), 10);
    const smtpUser = process.env.SMTP_USER || gmailUser;
    const smtpPass = (process.env.SMTP_PASS || gmailPass || "").replace(/\s+/g, "");

    // Attempt delivery if configured
    if (smtpUser && smtpPass) {
        try {
            if (nodemailer) {
                let transportConfig;
                if (gmailUser && gmailPass) {
                    transportConfig = {
                        service: "gmail",
                        auth: { user: gmailUser, pass: gmailPass }
                    };
                } else {
                    transportConfig = {
                        host: smtpHost,
                        port: smtpPort,
                        secure: smtpPort === 465,
                        auth: { user: smtpUser, pass: smtpPass }
                    };
                }

                const transporter = nodemailer.createTransport(transportConfig);
                await transporter.sendMail({
                    from: `"chatNut Support" <${smtpUser}>`,
                    to: toEmail,
                    subject: subject,
                    text: textContent,
                    html: htmlContent
                });
                console.log(`[Mail] Email delivered to ${toEmail}`);
                return { success: true, realSent: true, otp };
            } else if (smtpPort === 465 && smtpHost) {
                await sendDirectSslSmtp({
                    host: smtpHost,
                    port: 465,
                    user: smtpUser,
                    pass: smtpPass,
                    to: toEmail,
                    subject: subject,
                    text: textContent,
                    html: htmlContent
                });
                console.log(`[Mail] Email delivered via TLS to ${toEmail}`);
                return { success: true, realSent: true, otp };
            }
        } catch (err) {
            console.warn(`[Mail] SMTP notice: ${err.message}. Using console OTP.`);
            return { success: true, realSent: false, devMode: true, otp };
        }
    }

    return { success: true, realSent: false, devMode: true, otp };
}

/**
 * Built-in zero-dependency SMTP client over TLS (Port 465)
 */
function sendDirectSslSmtp({ host, port, user, pass, to, subject, text, html }) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect(port, host, { rejectUnauthorized: false }, () => {
            // Connected
        });

        let step = 0;
        socket.setEncoding("utf-8");

        const send = (cmd) => {
            socket.write(cmd + "\r\n");
        };

        socket.on("data", (data) => {
            const res = data.toString();
            const code = parseInt(res.substring(0, 3), 10);

            if (code >= 400) {
                socket.end();
                return reject(new Error(`SMTP error ${code}: ${res.trim()}`));
            }

            if (step === 0 && code === 220) {
                step++;
                send("EHLO localhost");
            } else if (step === 1 && code === 250) {
                step++;
                send("AUTH LOGIN");
            } else if (step === 2 && code === 334) {
                step++;
                send(Buffer.from(user).toString("base64"));
            } else if (step === 3 && code === 334) {
                step++;
                send(Buffer.from(pass).toString("base64"));
            } else if (step === 4 && code === 235) {
                step++;
                send(`MAIL FROM:<${user}>`);
            } else if (step === 5 && code === 250) {
                step++;
                send(`RCPT TO:<${to}>`);
            } else if (step === 6 && code === 250) {
                step++;
                send("DATA");
            } else if (step === 7 && code === 354) {
                step++;
                const boundary = "----=_Part_" + Date.now();
                const mail = [
                    `From: "chatNut" <${user}>`,
                    `To: <${to}>`,
                    `Subject: ${subject}`,
                    `MIME-Version: 1.0`,
                    `Content-Type: multipart/alternative; boundary="${boundary}"`,
                    ``,
                    `--${boundary}`,
                    `Content-Type: text/plain; charset=UTF-8`,
                    ``,
                    text,
                    ``,
                    `--${boundary}`,
                    `Content-Type: text/html; charset=UTF-8`,
                    ``,
                    html,
                    ``,
                    `--${boundary}--`,
                    `.`
                ].join("\r\n");

                socket.write(mail + "\r\n");
            } else if (step === 8 && code === 250) {
                step++;
                send("QUIT");
                socket.end();
                resolve(true);
            }
        });

        socket.on("error", (err) => {
            reject(err);
        });

        socket.setTimeout(12000, () => {
            socket.destroy();
            reject(new Error("SMTP connection timed out"));
        });
    });
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
    sendOtpEmail
};
