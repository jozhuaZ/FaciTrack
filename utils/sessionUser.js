function buildStudentUser(session, extraFields = {}) {
    return {
        id: session?.userId,
        name: session?.name,
        firstName: session.firstName,
        lastName: session.lastName,
        status: session.status,
        email: session?.email,
        role: session.role,
        profilePhoto: session?.profilePhoto || 'N/A',
        ...extraFields
    }
}

module.exports = {
    buildStudentUser
};