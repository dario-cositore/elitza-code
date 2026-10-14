"""Email -- IMAP/SMTP email integration.

Send and receive emails as Elitza.
"""

import email
import json
import os
import smtplib
import imaplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import decode_header
from typing import Optional

from elitza.tools import registry

IMAP_HOST = os.environ.get("EMAIL_IMAP_HOST", "")
IMAP_PORT = int(os.environ.get("EMAIL_IMAP_PORT", "993"))
SMTP_HOST = os.environ.get("EMAIL_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("EMAIL_SMTP_PORT", "587"))
EMAIL_USER = os.environ.get("EMAIL_USER", "")
EMAIL_PASS = os.environ.get("EMAIL_PASS", "")


def email_send(to: str, subject: str, body: str, html: bool = False) -> str:
    """Send an email.

    Args:
        to: Recipient email address
        subject: Email subject
        body: Email body (plain text or HTML)
        html: Whether body is HTML
    """
    if not SMTP_HOST or not EMAIL_USER or not EMAIL_PASS:
        return json.dumps({"error": "Email not configured (set EMAIL_SMTP_HOST, EMAIL_USER, EMAIL_PASS)"})

    msg = MIMEMultipart("alternative")
    msg["From"] = EMAIL_USER
    msg["To"] = to
    msg["Subject"] = subject

    if html:
        msg.attach(MIMEText(body, "html"))
    else:
        msg.attach(MIMEText(body, "plain"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(EMAIL_USER, EMAIL_PASS)
            server.send_message(msg)
        return json.dumps({"status": "sent", "to": to, "subject": subject})
    except Exception as e:
        return json.dumps({"error": str(e)})


def email_read(folder: str = "INBOX", limit: int = 10, unread_only: bool = False) -> str:
    """Read emails from a mailbox.

    Args:
        folder: IMAP folder to read
        limit: Max emails to return
        unread_only: Only return unread emails
    """
    if not IMAP_HOST or not EMAIL_USER or not EMAIL_PASS:
        return json.dumps({"error": "Email not configured (set EMAIL_IMAP_HOST, EMAIL_USER, EMAIL_PASS)"})

    try:
        mail = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        mail.login(EMAIL_USER, EMAIL_PASS)
        mail.select(folder)

        # Search for emails
        if unread_only:
            status, messages = mail.search(None, "UNSEEN")
        else:
            status, messages = mail.search(None, "ALL")

        if status != "OK":
            return json.dumps({"error": "Failed to search mailbox"})

        msg_ids = messages[0].split()
        # Get most recent
        msg_ids = msg_ids[-limit:] if len(msg_ids) > limit else msg_ids
        msg_ids.reverse()

        emails = []
        for mid in msg_ids:
            status, data = mail.fetch(mid, "(RFC822)")
            if status != "OK":
                continue

            msg = email.message_from_bytes(data[0][1])

            # Decode subject
            subject_parts = decode_header(msg.get("Subject", ""))
            subject = ""
            for part, encoding in subject_parts:
                if isinstance(part, bytes):
                    subject += part.decode(encoding or "utf-8", errors="replace")
                else:
                    subject += part

            # Get body
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == "text/plain":
                        body = part.get_payload(decode=True).decode(errors="replace")
                        break
            else:
                body = msg.get_payload(decode=True).decode(errors="replace")

            emails.append({
                "from": msg.get("From", ""),
                "to": msg.get("To", ""),
                "subject": subject,
                "date": msg.get("Date", ""),
                "body": body[:500],
            })

        mail.logout()
        return json.dumps({"emails": emails, "count": len(emails)})

    except Exception as e:
        return json.dumps({"error": str(e)})


registry.register(
    name="email_send",
    toolset="email",
    schema={
        "name": "email_send",
        "description": "Send an email.",
        "parameters": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "Recipient email"},
                "subject": {"type": "string", "description": "Email subject"},
                "body": {"type": "string", "description": "Email body"},
                "html": {"type": "boolean", "description": "Whether body is HTML"},
            },
            "required": ["to", "subject", "body"],
        },
    },
    handler=email_send,
    description="Send email",
)

registry.register(
    name="email_read",
    toolset="email",
    schema={
        "name": "email_read",
        "description": "Read emails from a mailbox.",
        "parameters": {
            "type": "object",
            "properties": {
                "folder": {"type": "string", "description": "IMAP folder (default: INBOX)"},
                "limit": {"type": "integer", "description": "Max emails (default 10)"},
                "unread_only": {"type": "boolean", "description": "Only unread emails"},
            },
        },
    },
    handler=email_read,
    description="Read email",
)
